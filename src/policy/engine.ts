/**
 * Motor de evaluación de políticas (feature 0006).
 *
 * `evaluatePolicySet` produce una `PolicyDecision` determinista dado un `PolicySet`,
 * el `SpendContext`, el monto y el reloj. La semántica de precedencia es FIJA e
 * independiente del orden del array de reglas (AC-4):
 *
 *   1. `deny` de recipient gana siempre.
 *   2. allowlist de recipient: lo no listado → deny.
 *   3. categoría denegada / límite per-tx por categoría / límite de ventana por
 *      categoría / ventanas temporales.
 *   4. (el presupuesto global lo evalúa el guard DESPUÉS, fuera de este motor.)
 *
 * Fail-safe: regla malformada → deny (`invalid_policy`); política que referencia un
 * campo del contexto ausente → deny (`missing_context_field`). Nunca allow silencioso.
 *
 * El reloj entra como `now: Date` (inyectable) para tests deterministas. La lectura
 * del gasto por categoría se inyecta como callback (`sumCategory`) para que el motor
 * no conozca el Storage — el guard la provee dentro de `withAgentLock`.
 */
import { parseAmount } from '../amount';
import type {
  CategoryRule,
  PolicyDecision,
  PolicyRule,
  PolicySet,
  RecipientRule,
  SpendContext,
  TimeWindowRule,
} from './types';
import { validatePolicySet } from './validate';

/** Suma escalada (`bigint`) ya reservada/committeada para una categoría en su ventana. */
export type CategorySpendReader = (
  category: string,
  windowFilterStart: Date,
) => Promise<bigint>;

/** Dependencias de una evaluación (todo inyectable para tests deterministas). */
export interface EvaluateDeps {
  policySet: PolicySet;
  context: SpendContext;
  /** Monto de ESTE gasto, ya escalado a bigint. */
  amountScaled: bigint;
  now: Date;
  sumCategory: CategorySpendReader;
}

function allow(ruleId: string | null = null): PolicyDecision {
  return { allowed: true, reasonCode: 'allow', ruleId };
}

function ruleId(rule: PolicyRule): string {
  return rule.id;
}

/** Filtra reglas por tipo preservando el tipo estrecho. */
function rulesOfType<T extends PolicyRule['type']>(
  set: PolicySet,
  type: T,
): ReadonlyArray<Extract<PolicyRule, { type: T }>> {
  return set.rules.filter(
    (r): r is Extract<PolicyRule, { type: T }> => r.type === type,
  );
}

// ── Recipient ────────────────────────────────────────────────────────────────

function evalRecipients(
  rules: ReadonlyArray<RecipientRule>,
  context: SpendContext,
): PolicyDecision | null {
  if (rules.length === 0) return null;

  // Fail-safe (AC-7b): hay reglas de recipient pero el contexto no trae recipient.
  if (context.recipient === undefined) {
    return {
      allowed: false,
      reasonCode: 'missing_context_field',
      ruleId: rules[0].id,
      message: 'a recipient policy is active but the spend context has no recipient',
    };
  }
  const recipient = context.recipient.toLowerCase();

  // 1. denylist gana siempre — se evalúa antes que cualquier allowlist.
  for (const rule of rules) {
    if (rule.deny?.some((r) => r.toLowerCase() === recipient)) {
      return {
        allowed: false,
        reasonCode: 'recipient_denied',
        ruleId: ruleId(rule),
        message: `recipient ${recipient} is on a denylist`,
      };
    }
  }

  // 2. si existe alguna allowlist, el recipient debe estar en al menos una de ellas.
  const allowRules = rules.filter((r) => r.allow !== undefined && r.allow.length > 0);
  if (allowRules.length > 0) {
    const listed = allowRules.some((rule) =>
      rule.allow?.some((r) => r.toLowerCase() === recipient),
    );
    if (!listed) {
      return {
        allowed: false,
        reasonCode: 'recipient_not_allowed',
        // La regla causante: la primera allowlist (determinista por orden estable
        // de ids; no cambia la DECISIÓN, solo qué id se reporta). Reportamos la de
        // menor id para independencia del orden del array.
        ruleId: [...allowRules].sort((a, b) => a.id.localeCompare(b.id))[0].id,
        message: `recipient ${recipient} is not on any allowlist`,
      };
    }
  }
  return null;
}

// ── Time windows ─────────────────────────────────────────────────────────────

/** Extrae (minuto-del-día, día-de-la-semana) de `now` en la TZ dada. */
function localMinuteAndDay(now: Date, timezone: string): { minute: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  let hour = 0;
  let minute = 0;
  let weekday = 'Sun';
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'weekday') weekday = p.value;
  }
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { minute: hour * 60 + minute, day: dayMap[weekday] ?? 0 };
}

function inWindow(rule: TimeWindowRule, minute: number, day: number): boolean {
  if (rule.daysOfWeek !== undefined && !rule.daysOfWeek.includes(day)) {
    return false;
  }
  const { startMinute, endMinute } = rule;
  if (startMinute <= endMinute) {
    // Franja normal dentro del mismo día. Borde: [start, end).
    return minute >= startMinute && minute < endMinute;
  }
  // Cruce de medianoche: permitido si >= start (noche) o < end (madrugada).
  return minute >= startMinute || minute < endMinute;
}

function evalTimeWindows(
  rules: ReadonlyArray<TimeWindowRule>,
  now: Date,
): PolicyDecision | null {
  for (const rule of rules) {
    const { minute, day } = localMinuteAndDay(now, rule.timezone);
    if (!inWindow(rule, minute, day)) {
      return {
        allowed: false,
        reasonCode: 'outside_time_window',
        ruleId: ruleId(rule),
        message: `spend attempted outside the allowed time window (${rule.timezone})`,
      };
    }
  }
  return null;
}

// ── Category ─────────────────────────────────────────────────────────────────

async function evalCategories(
  rules: ReadonlyArray<CategoryRule>,
  deps: EvaluateDeps,
): Promise<PolicyDecision | null> {
  if (rules.length === 0) return null;
  const { context, amountScaled, now, sumCategory } = deps;

  // Fail-safe (AC-7b): hay reglas de categoría pero el contexto no trae category.
  if (context.category === undefined) {
    return {
      allowed: false,
      reasonCode: 'missing_context_field',
      ruleId: rules[0].id,
      message: 'a category policy is active but the spend context has no category',
    };
  }
  const category = context.category.toLowerCase();

  // Solo aplican las reglas de ESTA categoría (independencia entre categorías, AC-5).
  const applicable = rules.filter((r) => r.category.toLowerCase() === category);

  for (const rule of applicable) {
    // Categoría explícitamente denegada.
    if (rule.allow === false) {
      return {
        allowed: false,
        reasonCode: 'category_denied',
        ruleId: ruleId(rule),
        message: `category "${category}" is denied`,
      };
    }
    // Per-tx por categoría.
    if (rule.maxAmountPerTx !== undefined) {
      if (amountScaled > parseAmount(rule.maxAmountPerTx)) {
        return {
          allowed: false,
          reasonCode: 'category_per_tx_exceeded',
          ruleId: ruleId(rule),
          message: `amount exceeds per-tx limit for category "${category}"`,
        };
      }
    }
  }

  // Límite de ventana por categoría: se lee el gasto acumulado de ESTA categoría.
  for (const rule of applicable) {
    if (rule.maxAmountPerWindow === undefined || rule.windowDurationSeconds === undefined) {
      continue;
    }
    const windowFilterStart = new Date(now.getTime() - rule.windowDurationSeconds * 1000);
    const usedScaled = await sumCategory(category, windowFilterStart);
    if (usedScaled + amountScaled > parseAmount(rule.maxAmountPerWindow)) {
      return {
        allowed: false,
        reasonCode: 'category_limit_exceeded',
        ruleId: ruleId(rule),
        message: `category "${category}" window limit exceeded`,
      };
    }
  }
  return null;
}

/**
 * Evalúa un `PolicySet` y devuelve una `PolicyDecision`. Precedencia fija (ver el
 * doc de arriba). Nunca lanza por deny: un deny es un valor de retorno. Un set
 * inválido produce un decision `invalid_policy` (el guard lo convierte en error).
 */
export async function evaluatePolicySet(deps: EvaluateDeps): Promise<PolicyDecision> {
  const { policySet } = deps;

  // AC-7a / AC-10: set inválido → deny fail-safe (nunca allow por un typo).
  const validation = validatePolicySet(policySet);
  if (!validation.ok) {
    return {
      allowed: false,
      reasonCode: 'invalid_policy',
      ruleId: validation.ruleId,
      message: validation.message,
    };
  }

  // 1+2. Recipients (deny gana; allowlist filtra).
  const recipientDecision = evalRecipients(
    rulesOfType(policySet, 'recipient'),
    deps.context,
  );
  if (recipientDecision) return recipientDecision;

  // 3a. Ventanas temporales.
  const timeDecision = evalTimeWindows(rulesOfType(policySet, 'timeWindow'), deps.now);
  if (timeDecision) return timeDecision;

  // 3b. Categorías (deny / per-tx / límite de ventana por categoría).
  const categoryDecision = await evalCategories(rulesOfType(policySet, 'category'), deps);
  if (categoryDecision) return categoryDecision;

  // Sin regla que deniegue → allow (el presupuesto global lo decide el guard después).
  return allow();
}
