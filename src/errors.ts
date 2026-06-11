/**
 * Errores tipados de Bridle. Cada uno lleva un `code` estable para que el host
 * los mapee a su transporte (HTTP, gRPC, etc.). Bridle es framework-agnóstico:
 * NO conoce códigos HTTP — el mapeo vive en el adapter del host (ej. Express).
 */

export type BridleErrorCode =
  | 'budget_exceeded'
  | 'amount_exceeds_per_tx_limit'
  | 'budget_policy_not_configured'
  | 'identity_mismatch'
  | 'nonce_too_old'
  | 'nonce_already_used'
  | 'reservation_conflict'
  | 'configuration_required'
  | 'invalid_amount';

export class BridleError extends Error {
  readonly code: BridleErrorCode;
  constructor(code: BridleErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** El gasto excede el presupuesto de la ventana. Lleva cuándo se liberaría. */
export class BudgetExceededError extends BridleError {
  /** Segundos hasta que la reserva más antigua salga de la ventana. */
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'budget exceeded for the current window') {
    super('budget_exceeded', message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** El monto supera el máximo por transacción. */
export class AmountExceedsPerTxLimitError extends BridleError {
  constructor(message = 'amount exceeds per-transaction limit') {
    super('amount_exceeds_per_tx_limit', message);
  }
}

/**
 * No hay política para el agente NI presupuesto por defecto configurado.
 * Fail-safe: Bridle deniega en vez de permitir (nunca fail-open). NO es transitorio
 * — es un error de configuración del host.
 */
export class BudgetPolicyNotConfiguredError extends BridleError {
  constructor(
    message = 'no budget policy for agent and no default budget configured; refusing to allow (fail-safe)',
  ) {
    super('budget_policy_not_configured', message);
  }
}

/** El firmante recuperado no coincide con la `agentAddress` declarada. */
export class IdentityMismatchError extends BridleError {
  constructor(message = 'recovered signer does not match declared agent address') {
    super('identity_mismatch', message);
  }
}

/** El timestamp del nonce está fuera de la ventana de frescura. */
export class NonceTooOldError extends BridleError {
  constructor(message = 'nonce timestamp is too old or in the future') {
    super('nonce_too_old', message);
  }
}

/** El nonce ya fue usado (anti-replay). */
export class NonceAlreadyUsedError extends BridleError {
  constructor(message = 'nonce has already been used') {
    super('nonce_already_used', message);
  }
}

/**
 * Ya existe una reserva con ese `reservationId`. Garantiza idempotencia: el host
 * NO debe reusar un id (una reserva por id). Ambos adapters lo lanzan igual.
 */
export class ReservationConflictError extends BridleError {
  constructor(reservationId: string) {
    super('reservation_conflict', `reservation already exists: ${reservationId}`);
  }
}

/** El monto no es un decimal string válido. */
export class InvalidAmountError extends BridleError {
  constructor(message = 'amount is not a valid non-negative decimal string') {
    super('invalid_amount', message);
  }
}

/**
 * Se usó una feature que requiere configuración ausente. Hoy: llamar
 * `verifyAndConsumeNonce` sin haber pasado un `signatureVerifier` al `BridleGuard`.
 * Las operaciones de presupuesto NO requieren verifier; las de identidad/nonce sí.
 */
export class ConfigurationError extends BridleError {
  constructor(message: string) {
    super('configuration_required', message);
  }
}
