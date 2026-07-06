/**
 * Validación de `PolicySet` (feature 0006, AC-10).
 *
 * `validatePolicySet` devuelve un resultado tipado (ok / error que identifica la
 * regla ofensora) SIN lanzar — pensado para que el host valide en tiempo de
 * configuración. El guard lo usa al cargar el set y trata un set inválido como un
 * deny fail-safe (AC-7a): un typo en una política jamás abre el gasto.
 */
import { parseAmount } from '../amount';
import { InvalidAmountError } from '../errors';
import { POLICY_SCHEMA_VERSION, type PolicyRule } from './types';

/** Resultado de validar un `PolicySet`. Discriminado por `ok`. */
export type PolicyValidationResult =
  | { ok: true }
  | { ok: false; ruleId: string | null; message: string };

const MINUTES_IN_DAY = 24 * 60;

/** ¿Es `tz` una zona horaria IANA/UTC válida y soportada por el runtime? */
function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    // Intl lanza RangeError para zonas desconocidas. "UTC" es siempre válida.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** ¿Es `amount` un decimal string parseable por `parseAmount`? */
function isParseableAmount(amount: unknown): boolean {
  if (typeof amount !== 'string') return false;
  try {
    parseAmount(amount);
    return true;
  } catch (err) {
    if (err instanceof InvalidAmountError) return false;
    throw err;
  }
}

function err(ruleId: string | null, message: string): PolicyValidationResult {
  return { ok: false, ruleId, message };
}

/** Valida una regla individual. */
function validateRule(rule: PolicyRule, index: number): PolicyValidationResult {
  // El `id` es la ancla de trazabilidad — sin él una decisión no es auditable.
  const ruleId =
    typeof (rule as { id?: unknown }).id === 'string' ? (rule as { id: string }).id : null;
  if (ruleId === null || ruleId.length === 0) {
    return err(null, `rule at index ${index} is missing a non-empty string "id"`);
  }

  switch (rule.type) {
    case 'recipient': {
      const hasAllow = rule.allow !== undefined;
      const hasDeny = rule.deny !== undefined;
      if (!hasAllow && !hasDeny) {
        return err(ruleId, `recipient rule "${ruleId}" must define "allow" and/or "deny"`);
      }
      // allowlist vacía es un error (AC-10): denegaría todo silenciosamente por
      // configuración accidental — es casi siempre un bug, no una intención.
      if (hasAllow && (!Array.isArray(rule.allow) || rule.allow.length === 0)) {
        return err(ruleId, `recipient rule "${ruleId}" has an empty allowlist`);
      }
      if (hasDeny && (!Array.isArray(rule.deny) || rule.deny.length === 0)) {
        return err(ruleId, `recipient rule "${ruleId}" has an empty denylist`);
      }
      return { ok: true };
    }

    case 'category': {
      if (typeof rule.category !== 'string' || rule.category.length === 0) {
        return err(ruleId, `category rule "${ruleId}" is missing a non-empty "category"`);
      }
      if (rule.maxAmountPerWindow !== undefined) {
        if (!isParseableAmount(rule.maxAmountPerWindow)) {
          return err(ruleId, `category rule "${ruleId}" has an unparseable maxAmountPerWindow`);
        }
        if (
          typeof rule.windowDurationSeconds !== 'number' ||
          !Number.isFinite(rule.windowDurationSeconds) ||
          rule.windowDurationSeconds <= 0
        ) {
          return err(
            ruleId,
            `category rule "${ruleId}" with maxAmountPerWindow needs a positive windowDurationSeconds`,
          );
        }
      }
      if (rule.maxAmountPerTx !== undefined && !isParseableAmount(rule.maxAmountPerTx)) {
        return err(ruleId, `category rule "${ruleId}" has an unparseable maxAmountPerTx`);
      }
      return { ok: true };
    }

    case 'timeWindow': {
      if (!isValidTimezone(rule.timezone)) {
        return err(ruleId, `timeWindow rule "${ruleId}" has an invalid IANA/UTC timezone`);
      }
      for (const [field, value] of [
        ['startMinute', rule.startMinute],
        ['endMinute', rule.endMinute],
      ] as const) {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > MINUTES_IN_DAY
        ) {
          return err(
            ruleId,
            `timeWindow rule "${ruleId}" has an out-of-range ${field} (expected 0..${MINUTES_IN_DAY})`,
          );
        }
      }
      if (rule.daysOfWeek !== undefined) {
        if (!Array.isArray(rule.daysOfWeek) || rule.daysOfWeek.length === 0) {
          return err(ruleId, `timeWindow rule "${ruleId}" has an empty daysOfWeek`);
        }
        for (const d of rule.daysOfWeek) {
          if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
            return err(ruleId, `timeWindow rule "${ruleId}" has an invalid day-of-week (expected 0..6)`);
          }
        }
      }
      return { ok: true };
    }

    default: {
      // Fail-safe estructural (AC-7a): tipo de regla desconocido → inválido.
      // why: `rule` está tipado como unión cerrada; en runtime puede llegar JSON
      // arbitrario, así que leemos `type` defensivamente sin `any`.
      const unknownType = (rule as { type?: unknown }).type;
      return err(ruleId, `unknown rule type ${JSON.stringify(unknownType)} in rule "${ruleId}"`);
    }
  }
}

/**
 * Valida un `PolicySet` completo. NO lanza: devuelve `{ ok: true }` o un error que
 * identifica la regla ofensora (`ruleId`). El guard lo trata como deny fail-safe.
 */
export function validatePolicySet(set: unknown): PolicyValidationResult {
  if (typeof set !== 'object' || set === null) {
    return err(null, 'policySet must be a non-null object');
  }
  const candidate = set as { schemaVersion?: unknown; rules?: unknown };
  if (candidate.schemaVersion !== POLICY_SCHEMA_VERSION) {
    return err(
      null,
      `unsupported policy schemaVersion ${JSON.stringify(candidate.schemaVersion)} (expected ${POLICY_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(candidate.rules)) {
    return err(null, 'policySet.rules must be an array');
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < candidate.rules.length; i += 1) {
    const rule = candidate.rules[i] as PolicyRule;
    const result = validateRule(rule, i);
    if (!result.ok) return result;
    const id = (rule as { id: string }).id;
    if (seenIds.has(id)) {
      return err(id, `duplicate rule id "${id}"`);
    }
    seenIds.add(id);
  }
  return { ok: true };
}
