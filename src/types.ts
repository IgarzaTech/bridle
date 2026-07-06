/**
 * Tipos públicos de Bridle.
 *
 * Convención de montos (ver AC-4 / AC-12 de la spec 0004):
 *  - En los BORDES (API pública, serialización) los montos viajan como `string`
 *    decimal (ej. "100.00"). NUNCA como `number` (perdería precisión) ni como
 *    `bigint` (no es JSON-serializable).
 *  - INTERNAMENTE el cómputo y la comparación se hacen en `bigint` escalado a
 *    `SCALE_DECIMALS` (6 decimales fijos — supuesto del MVP, stablecoins USD).
 */

import type { PolicyAuditSink, PolicySet, SpendContext } from './policy/types';

/** Política de presupuesto de un agente para una moneda. */
export interface AgentBudgetRecord {
  agentAddress: string;
  currency: string;
  /** Ventana rolling en segundos. */
  windowDurationSeconds: number;
  /** Máximo gastado/reservado por ventana, como decimal string (ej. "100.00"). */
  maxAmountPerWindow: string;
  /** Máximo por transacción, opcional. Decimal string o null. */
  maxAmountPerTx: string | null;
  /** Opt-in explícito: si true, el agente no tiene límite (nunca implícito). */
  unlimited: boolean;
}

/** Estado de una entrada del ledger. Máquina de estados exclusiva (ver AC-7 de 0003). */
export type LedgerStatus = 'reserved' | 'committed' | 'released';

/**
 * Entrada del ledger de reservas. El monto va escalado a entero (`bigint`) — esta
 * es la representación INTERNA que cruza la interfaz Storage, no el wire.
 */
export interface LedgerEntry {
  /** Id único de la reserva (el host suele usar su challengeId). */
  reservationId: string;
  agentAddress: string;
  currency: string;
  /** Monto escalado a entero (6 decimales). */
  amountScaled: bigint;
  status: LedgerStatus;
  /** Instante de la reserva — ancla de la ventana rolling. */
  windowStart: Date;
  /** Cuándo la reserva pasa a ser expirable si sigue en `reserved`. */
  expiresAt: Date;
  /**
   * Categoría del gasto (feature 0006), normalizada a lowercase. OPCIONAL y aditiva:
   * las reservas sin política de categoría la dejan como `null`/ausente. Se persiste
   * para poder sumar el gasto por categoría dentro de la ventana (límite por categoría).
   */
  category?: string | null;
}

/** Presupuesto por defecto aplicado a agentes sin `AgentBudgetRecord` (fail-safe). */
export interface DefaultBudget {
  maxAmountPerWindow: string;
  windowDurationSeconds: number;
}

/** Configuración del `BridleGuard`. */
export interface BridleConfig {
  /**
   * Presupuesto por defecto para agentes sin política propia. Si está ausente y
   * el agente no tiene `AgentBudgetRecord`, `checkAndReserve` LANZA
   * `BudgetPolicyNotConfiguredError` (fail-safe — nunca fail-open).
   */
  defaultBudget?: DefaultBudget;
  /** Edad máxima del nonce en segundos (anti-replay por timestamp). Default 300. */
  nonceMaxAgeSeconds?: number;
  /** TTL por defecto de una reserva antes de ser expirable. Default = ventana. */
  defaultReservationTtlSeconds?: number;
  /**
   * `PolicySet` por defecto aplicado a agentes sin uno propio (feature 0006). El
   * origen del set puede ser estático (aquí) o vía `Storage.getPolicySet` — este
   * es el fallback estático. Si está ausente Y el storage no devuelve set → solo
   * presupuesto (comportamiento 0004, AC-8).
   */
  defaultPolicySet?: PolicySet;
  /**
   * Sink de auditoría para las decisiones de política (feature 0006, AC-9). Recibe
   * TODA decisión (allow y deny). Si se omite, se usa un sink no-op (sin efectos
   * colaterales ni timers). Bridle no impone infraestructura de logging.
   */
  auditSink?: PolicyAuditSink;
}

/** Entrada para reservar presupuesto. El monto es wire string (AC-12). */
export interface ReserveInput {
  /** Id único de la reserva (idempotencia: una reserva por reservationId). */
  reservationId: string;
  agentAddress: string;
  /** Monto decimal string (ej. "1.50"). */
  amount: string;
  currency: string;
  /** TTL de esta reserva en segundos; si se omite, usa el default de config. */
  reservationTtlSeconds?: number;
  /**
   * Contexto de gasto para el Policy Engine (feature 0006). OPCIONAL: sin contexto y
   * sin `PolicySet` configurado, el comportamiento es idéntico a 0004 (AC-8). Si hay
   * una política activa que referencia un campo (recipient/category) ausente aquí, la
   * reserva se DENIEGA (fail-safe, AC-7b) — nunca se ignora la regla por falta de datos.
   */
  context?: SpendContext;
}

/** Prueba de identidad del agente para anti-DoS (firma sobre address+nonce). */
export interface IdentityProof {
  agentAddress: string;
  /** Nonce único (freshness + anti-replay). */
  nonce: string;
  /** Unix timestamp (segundos) en que se generó el nonce. */
  nonceTimestamp: number;
  /** Firma ECDSA (0x{r}{s}{v}, 65 bytes hex) sobre el mensaje canónico. */
  signature: string;
}
