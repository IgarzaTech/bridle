/**
 * `@nexopay/bridle/x402` — enganche del guardrail delante de un intento de pago.
 *
 * NO reimplementa x402. Es un wrapper agnóstico de framework: reserva presupuesto
 * ANTES de pagar, hace commit al liquidar y release si el pago falla. El rail de
 * pago concreto (MPP/Tempo/lo que sea) lo provee el host detrás de `payFn` /
 * `PaymentRail` — Bridle no conoce sus detalles (AC-7). Semántica HTTP-402 genérica,
 * no acoplada a ningún facilitator.
 */
import type { BridleGuard } from '../guard';
import { BridleError } from '../errors';

/** Datos del intento de pago que Bridle reserva. Montos como wire string. */
export interface PaymentAttempt {
  /** Id único de la reserva (idempotencia). */
  reservationId: string;
  agentAddress: string;
  amount: string;
  currency: string;
  /** TTL opcional de la reserva (segundos). */
  reservationTtlSeconds?: number;
}

/**
 * El rail de pago concreto lo implementa el host. Bridle solo lo invoca; mantiene
 * el rail abstracto (AC-7). `pay` resuelve si el pago liquidó, rechaza si falló.
 */
export interface PaymentRail<T = unknown> {
  pay(attempt: PaymentAttempt): Promise<T>;
}

/**
 * Envuelve un intento de pago con el guardrail de presupuesto.
 *
 *  1. `checkAndReserve` — si DENY, LANZA y `payFn` NUNCA se ejecuta (no se paga).
 *  2. `payFn()` — el pago real (rail del host).
 *  3. éxito → `commit`; fallo → `release` y re-lanza el error del pago.
 *
 * El `reservationId` da idempotencia: reusar uno ya reservado fallará en el storage.
 */
export async function withBudget<T>(
  guard: BridleGuard,
  attempt: PaymentAttempt,
  payFn: () => Promise<T>,
): Promise<T> {
  await guard.checkAndReserve({
    reservationId: attempt.reservationId,
    agentAddress: attempt.agentAddress,
    amount: attempt.amount,
    currency: attempt.currency,
    reservationTtlSeconds: attempt.reservationTtlSeconds,
  });

  let result: T;
  try {
    result = await payFn();
  } catch (payErr) {
    await guard.release(attempt.reservationId);
    throw payErr;
  }
  await guard.commit(attempt.reservationId);
  return result;
}

/** Azúcar: envuelve un `PaymentRail` en vez de una `payFn` suelta. */
export function withBudgetRail<T>(
  guard: BridleGuard,
  attempt: PaymentAttempt,
  rail: PaymentRail<T>,
): Promise<T> {
  return withBudget(guard, attempt, () => rail.pay(attempt));
}

// ── Adapter Express delgado (nice-to-have) ──────────────────────────────────

/** Mapeo de error de Bridle → respuesta HTTP. El host decide si lo usa. */
export interface HttpErrorResponse {
  status: number;
  body: { code: string; message: string; retryAfterSeconds?: number };
}

/**
 * Mapea un `BridleError` a un código HTTP coherente con la spec 0003:
 *  - budget_exceeded → 429 (sobre presupuesto; reintentar tras la ventana)
 *  - amount_exceeds_per_tx_limit → 429
 *  - budget_policy_not_configured → 503 (config del servidor; no transitorio)
 *  - identity_mismatch → 403
 *  - nonce_too_old → 422
 *  - nonce_already_used → 409
 *  - configuration_required → 503 (feature usada sin configuración; no transitorio)
 *  - invalid_amount → 400
 */
export function mapBridleErrorToHttp(err: BridleError): HttpErrorResponse {
  const base = { code: err.code, message: err.message };
  switch (err.code) {
    case 'budget_exceeded': {
      const retryAfterSeconds = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
      return { status: 429, body: { ...base, retryAfterSeconds } };
    }
    case 'amount_exceeds_per_tx_limit':
      return { status: 429, body: base };
    case 'budget_policy_not_configured':
      return { status: 503, body: base };
    case 'identity_mismatch':
      return { status: 403, body: base };
    case 'nonce_too_old':
      return { status: 422, body: base };
    case 'nonce_already_used':
      return { status: 409, body: base };
    case 'reservation_conflict':
      return { status: 409, body: base };
    case 'configuration_required':
      return { status: 503, body: base };
    case 'invalid_amount':
      return { status: 400, body: base };
    default:
      return { status: 400, body: base };
  }
}

/** Tipos estructurales mínimos de Express (sin acoplar `express` como dependencia). */
interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}
type ExpressLikeNext = (err?: unknown) => void;

/**
 * Error-handling middleware de Express: si el error es un `BridleError`, responde
 * con el HTTP mapeado; si no, lo delega a `next`. Úsalo al final de tu cadena:
 *   app.use(bridleExpressErrorHandler);
 */
export function bridleExpressErrorHandler(
  err: unknown,
  _req: unknown,
  res: ExpressLikeResponse,
  next: ExpressLikeNext,
): void {
  if (err instanceof BridleError) {
    const { status, body } = mapBridleErrorToHttp(err);
    res.status(status).json(body);
    return;
  }
  next(err);
}
