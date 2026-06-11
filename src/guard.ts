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
} from './errors';

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

  constructor(deps: BridleGuardDeps) {
    this.storage = deps.storage;
    this.signatureVerifier = deps.signatureVerifier;
    this.config = deps.config;
    this.nonceMaxAgeSeconds = deps.config.nonceMaxAgeSeconds ?? DEFAULT_NONCE_MAX_AGE_SECONDS;
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
   *  - sin política ni default → BudgetPolicyNotConfiguredError (fail-safe)
   *  - monto > maxPerTx → AmountExceedsPerTxLimitError
   *  - total de ventana + monto > maxWindow → BudgetExceededError
   * La sección crítica corre dentro de `withAgentLock` (serializa por agente).
   */
  async checkAndReserve(input: ReserveInput, now: Date = new Date()): Promise<void> {
    const amountScaled = parseAmount(input.amount);

    const budget = await this.storage.getBudget(input.agentAddress, input.currency);

    let maxWindowScaled: bigint;
    let windowSeconds: number;
    let maxPerTxScaled: bigint | null = null;

    if (budget) {
      if (budget.unlimited) {
        return; // opt-in explícito: sin límite, sin ledger entry.
      }
      maxWindowScaled = parseAmount(budget.maxAmountPerWindow);
      windowSeconds = budget.windowDurationSeconds;
      maxPerTxScaled = budget.maxAmountPerTx !== null ? parseAmount(budget.maxAmountPerTx) : null;
    } else if (this.config.defaultBudget) {
      maxWindowScaled = parseAmount(this.config.defaultBudget.maxAmountPerWindow);
      windowSeconds = this.config.defaultBudget.windowDurationSeconds;
    } else {
      // Fail-safe: nunca permitir sin una política explícita.
      throw new BudgetPolicyNotConfiguredError();
    }

    // Límite por transacción: no depende de la ventana, se evalúa fuera del lock.
    if (maxPerTxScaled !== null && amountScaled > maxPerTxScaled) {
      throw new AmountExceedsPerTxLimitError();
    }

    const ttlSeconds =
      input.reservationTtlSeconds ?? this.config.defaultReservationTtlSeconds ?? windowSeconds;

    await this.storage.withAgentLock(input.agentAddress, input.currency, async () => {
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
      };
      await this.storage.insertReservation(entry);
    });
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
