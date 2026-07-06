import type { BridleStorage } from './storage';
import type { SignatureVerifier } from './signature-verifier';
import type { BridleConfig, IdentityProof, LedgerEntry, ReserveInput } from './types';
import { parseAmount } from './amount';
import {
  AmountExceedsPerTxLimitError,
  BudgetExceededError,
  BudgetPolicyNotConfiguredError,
  ConfigurationError,
  IdentityMismatchError,
  NonceTooOldError,
  PolicyDeniedError,
  PolicyInvalidError,
} from './errors';
import type {
  PolicyAuditSink,
  PolicyDecision,
  PolicySet,
  SpendContext,
} from './policy/types';
import { noopAuditSink } from './policy/types';
import { evaluatePolicySet } from './policy/engine';

const DEFAULT_NONCE_MAX_AGE_SECONDS = 300;

/** Dependencias del guard — todas por inyección manual (sin DI framework). */
export interface BridleGuardDeps {
  storage: BridleStorage;
  /**
   * OPCIONAL: solo se necesita para las features de identidad/anti-DoS
   * (`verifyAndConsumeNonce`). Las operaciones de presupuesto
   * (checkAndReserve/commit/release/expire) funcionan SIN verifier. Si quieres
   * identidad, pasa un `Secp256k1SignatureVerifier` (o el tuyo) explícitamente.
   */
  signatureVerifier?: SignatureVerifier;
  config: BridleConfig;
}

/**
 * Mensaje canónico que el agente firma para probar su identidad. El quickstart y
 * los tests deben firmar EXACTAMENTE esta cadena. Cambiarla rompe compatibilidad.
 */
export function canonicalIdentityMessage(
  agentAddress: string,
  nonce: string,
  nonceTimestamp: number,
): string {
  return `bridle-identity:${agentAddress.toLowerCase()}:${nonce}:${nonceTimestamp}`;
}

/**
 * `BridleGuard` — núcleo framework-agnóstico del guardrail de presupuesto.
 *
 * Reserva-en-issue + commit/release, ventana rolling, fail-safe por defecto.
 * El check+reserve corre SIEMPRE dentro de `storage.withAgentLock` (la única
 * forma de obtener la garantía de no-overcommit; ver el contrato en `storage.ts`).
 *
 * El `signatureVerifier` es OPCIONAL: solo lo necesita `verifyAndConsumeNonce`
 * (identidad/anti-DoS). Para el caso de uso "solo presupuesto" (el wedge), construye
 * el guard sin verifier.
 */
export class BridleGuard {
  private readonly storage: BridleStorage;
  private readonly signatureVerifier?: SignatureVerifier;
  private readonly config: BridleConfig;
  private readonly nonceMaxAgeSeconds: number;
  private readonly auditSink: PolicyAuditSink;

  constructor(deps: BridleGuardDeps) {
    this.storage = deps.storage;
    this.signatureVerifier = deps.signatureVerifier;
    this.config = deps.config;
    this.nonceMaxAgeSeconds = deps.config.nonceMaxAgeSeconds ?? DEFAULT_NONCE_MAX_AGE_SECONDS;
    // Default no-op: sin efectos colaterales ni timers (mismo criterio del guard).
    this.auditSink = deps.config.auditSink ?? noopAuditSink;
  }

  /**
   * Verifica la identidad declarada y consume el nonce (anti-DoS).
   * REQUIERE haber pasado un `signatureVerifier` al construir el guard; si no,
   * lanza `ConfigurationError` (las features de identidad no funcionan sin él).
   * Orden FIJO (no filtrar información): firma → freshness → consumo/anti-replay.
   *  - sin verifier configurado → ConfigurationError
   *  - firma inválida o no coincide → IdentityMismatchError
   *  - timestamp fuera de ventana → NonceTooOldError
   *  - nonce reusado → NonceAlreadyUsedError (lo lanza el storage)
   */
  async verifyAndConsumeNonce(proof: IdentityProof, now: Date = new Date()): Promise<void> {
    // 0. El verifier es opcional en el guard; las features de identidad lo exigen.
    if (!this.signatureVerifier) {
      throw new ConfigurationError(
        'verifyAndConsumeNonce requires a signatureVerifier; pass one to BridleGuard ' +
          '(e.g. new Secp256k1SignatureVerifier()). Budget operations do not need it.',
      );
    }
    const verifier = this.signatureVerifier;

    // 1. Firma PRIMERO — un atacante con timestamp viejo y firma inválida recibe
    //    identity_mismatch sin que se le revele si el timestamp era válido.
    const message = canonicalIdentityMessage(
      proof.agentAddress,
      proof.nonce,
      proof.nonceTimestamp,
    );
    let recovered: string;
    try {
      recovered = await verifier.recover(proof.signature, message);
    } catch {
      throw new IdentityMismatchError();
    }
    if (recovered.toLowerCase() !== proof.agentAddress.toLowerCase()) {
      throw new IdentityMismatchError();
    }

    // 2. Freshness (cubre timestamps viejos Y futuros con Math.abs).
    const nowSec = Math.floor(now.getTime() / 1000);
    if (Math.abs(nowSec - proof.nonceTimestamp) > this.nonceMaxAgeSeconds) {
      throw new NonceTooOldError();
    }

    // 3. Anti-replay. El nonce vive el doble de la ventana de frescura para que
    //    una firma capturada no se reuse tras la poda.
    const expiresAt = new Date(now.getTime() + this.nonceMaxAgeSeconds * 2 * 1000);
    await this.storage.consumeNonce(proof.nonce, proof.agentAddress, expiresAt);
  }

  /**
   * Verifica el presupuesto y RESERVA el monto. Lanza si deniega.
   *  - política deniega (feature 0006) → PolicyDeniedError (deny NO inserta reserva)
   *  - PolicySet inválido / campo de contexto ausente → PolicyInvalidError (fail-safe)
   *  - sin política ni default → BudgetPolicyNotConfiguredError (fail-safe)
   *  - monto > maxPerTx → AmountExceedsPerTxLimitError
   *  - total de ventana + monto > maxWindow → BudgetExceededError
   *
   * La sección crítica corre dentro de `withAgentLock` (serializa por agente). La
   * evaluación de políticas ocurre DENTRO de esa misma sección — hereda la garantía
   * de concurrencia: un deny por política no inserta reserva (AC-2).
   */
  async checkAndReserve(input: ReserveInput, now: Date = new Date()): Promise<void> {
    const amountScaled = parseAmount(input.amount);
    const context: SpendContext = input.context ?? {};
    // Normalizamos la categoría a lowercase una sola vez: es lo que se persiste y lo
    // que la suma por categoría compara (consistencia con el motor de políticas).
    const category = context.category !== undefined ? context.category.toLowerCase() : null;

    const budget = await this.storage.getBudget(input.agentAddress, input.currency);

    let unlimited = false;
    let maxWindowScaled: bigint | null = null;
    let windowSeconds: number | null = null;
    let maxPerTxScaled: bigint | null = null;

    if (budget) {
      if (budget.unlimited) {
        unlimited = true;
      } else {
        maxWindowScaled = parseAmount(budget.maxAmountPerWindow);
        windowSeconds = budget.windowDurationSeconds;
        maxPerTxScaled = budget.maxAmountPerTx !== null ? parseAmount(budget.maxAmountPerTx) : null;
      }
    } else if (this.config.defaultBudget) {
      maxWindowScaled = parseAmount(this.config.defaultBudget.maxAmountPerWindow);
      windowSeconds = this.config.defaultBudget.windowDurationSeconds;
    }

    // Resolvemos el PolicySet: primero por Storage (si el adapter lo soporta), luego
    // el default estático de config. La lectura por Storage entra en el lock más abajo.
    const staticPolicySet = this.config.defaultPolicySet ?? null;

    // Sin presupuesto (ni fila, ni unlimited, ni default) Y sin política → fail-safe.
    if (!unlimited && maxWindowScaled === null && staticPolicySet === null && !this.storage.getPolicySet) {
      throw new BudgetPolicyNotConfiguredError();
    }

    // Límite global por transacción: no depende de la ventana, se evalúa fuera del lock.
    if (maxPerTxScaled !== null && amountScaled > maxPerTxScaled) {
      throw new AmountExceedsPerTxLimitError();
    }

    const ttlSeconds =
      input.reservationTtlSeconds ??
      this.config.defaultReservationTtlSeconds ??
      windowSeconds ??
      DEFAULT_NONCE_MAX_AGE_SECONDS;

    await this.storage.withAgentLock(input.agentAddress, input.currency, async () => {
      // ── 1. Policy Engine (feature 0006): dentro del lock, ANTES del presupuesto ──
      const storagePolicySet = this.storage.getPolicySet
        ? await this.storage.getPolicySet(input.agentAddress, input.currency)
        : null;
      const policySet: PolicySet | null = storagePolicySet ?? staticPolicySet;

      if (policySet) {
        const decision = await evaluatePolicySet({
          policySet,
          context,
          amountScaled,
          now,
          sumCategory: (cat, windowFilterStart) =>
            this.sumCategorySpend(input.agentAddress, input.currency, cat, windowFilterStart),
        });
        this.emitAudit(input, now, decision);
        if (!decision.allowed) {
          // Un deny por política NO inserta reserva (AC-2). Error distinguible del
          // deny de presupuesto (AC-11): política → PolicyDenied/Invalid (403).
          if (decision.reasonCode === 'invalid_policy') {
            throw new PolicyInvalidError(
              decision.message ?? 'policy set is invalid',
              decision.ruleId,
            );
          }
          if (decision.reasonCode === 'missing_context_field') {
            throw new PolicyInvalidError(
              decision.message ?? 'spend context is missing a field a policy requires',
              decision.ruleId,
            );
          }
          throw new PolicyDeniedError(
            decision.reasonCode,
            decision.ruleId,
            decision.message ?? 'denied by policy',
          );
        }
      }

      // ── 2. Presupuesto global (0004): unlimited → allow sin ledger entry ──
      if (unlimited) {
        return;
      }
      // Si tras el Policy Engine no hay presupuesto configurado → fail-safe.
      if (maxWindowScaled === null || windowSeconds === null) {
        throw new BudgetPolicyNotConfiguredError();
      }

      // Mini-sweep inline: libera reservas zombis del propio agente antes de sumar.
      await this.storage.releaseExpiredForAgent(input.agentAddress, input.currency, now);

      const windowFilterStart = new Date(now.getTime() - windowSeconds * 1000);
      const usedScaled = await this.storage.sumActiveInWindow(
        input.agentAddress,
        input.currency,
        windowFilterStart,
      );

      if (usedScaled + amountScaled > maxWindowScaled) {
        // why: sin los timestamps por-entrada aquí, usamos el peor caso (una ventana
        // completa) como Retry-After. Conservador: el cliente reintenta a lo sumo
        // tras `windowSeconds`. Afinar el retry exacto es post-MVP.
        throw new BudgetExceededError(windowSeconds);
      }

      const entry: LedgerEntry = {
        reservationId: input.reservationId,
        agentAddress: input.agentAddress,
        currency: input.currency,
        amountScaled,
        status: 'reserved',
        windowStart: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        category,
      };
      await this.storage.insertReservation(entry);
    });
  }

  /**
   * Lee el gasto acumulado de UNA categoría en su ventana. Fail-safe (feature 0006):
   * si el adapter de Storage no implementa `sumActiveInWindowByCategory` pero hay una
   * regla de categoría con límite de ventana, DENEGAMOS (nunca ignorar el límite en
   * silencio) — se manifiesta como `PolicyInvalidError` vía el error tipado.
   */
  private sumCategorySpend(
    agentAddress: string,
    currency: string,
    category: string,
    windowFilterStart: Date,
  ): Promise<bigint> {
    if (!this.storage.sumActiveInWindowByCategory) {
      throw new PolicyInvalidError(
        'a category window limit is configured but the storage adapter does not ' +
          'implement sumActiveInWindowByCategory; refusing to allow (fail-safe)',
      );
    }
    return this.storage.sumActiveInWindowByCategory(
      agentAddress,
      currency,
      category,
      windowFilterStart,
    );
  }

  /**
   * Emite una decisión al sink de auditoría (allow y deny). NUNCA lanza: el sink es
   * best-effort del host. Un allow legítimo se emite DENTRO del callback de
   * `withAgentLock`, antes de `insertReservation`; si el sink lanzara y la excepción
   * escapara, el adapter Postgres haría ROLLBACK y rechazaríamos un gasto que estaba
   * dentro de presupuesto. Por eso la aislamos aquí (el hook de auditoría no puede
   * romper el flujo de reserva ni el deny de política).
   */
  private emitAudit(input: ReserveInput, at: Date, decision: PolicyDecision): void {
    try {
      this.auditSink.record({
        agentAddress: input.agentAddress,
        currency: input.currency,
        reservationId: input.reservationId,
        decision,
        at,
      });
    } catch {
      // why: el sink es best-effort; un fallo de auditoría nunca debe convertir un
      // allow en rechazo ni enmascarar el error de política de un deny. Se traga.
    }
  }

  /** Convierte una reserva en gasto confirmado (`reserved`/`released` → `committed`). */
  async commit(reservationId: string): Promise<void> {
    await this.storage.transitionLedger(reservationId, 'committed');
  }

  /** Libera una reserva (`reserved` → `released`; `committed` es no-op). */
  async release(reservationId: string): Promise<void> {
    await this.storage.transitionLedger(reservationId, 'released');
  }

  /**
   * Barre reservas expiradas (global) y poda nonces vencidos.
   *
   * ⚠ El host DEBE invocar `expire()` periódicamente. Bridle NO arranca ningún
   * scheduler por su cuenta: si nadie llama a `expire()`, las reservas no
   * redimidas se acumulan como zombis y bloquean al agente legítimo. Ver
   * `startExpirySweeper` para un helper opt-in.
   */
  async expire(now: Date = new Date()): Promise<{ releasedReservations: number; prunedNonces: number }> {
    const releasedReservations = await this.storage.releaseAllExpired(now);
    const prunedNonces = await this.storage.pruneExpiredNonces(now);
    return { releasedReservations, prunedNonces };
  }

  /**
   * Helper OPT-IN: arranca un sweeper que llama `expire()` cada `intervalMs`.
   * Devuelve una función para detenerlo. NO se arranca solo — el usuario lo
   * activa a propósito. El timer usa `unref()` para no mantener vivo el proceso.
   */
  startExpirySweeper(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.expire().catch(() => undefined);
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return () => clearInterval(timer);
  }
}
