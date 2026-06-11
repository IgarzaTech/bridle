import type { AgentBudgetRecord, LedgerEntry, LedgerStatus } from './types';

/**
 * `BridleStorage` — el contrato de persistencia de Bridle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠ CONTRATO CRÍTICO DE CONCURRENCIA (`withAgentLock`)
 * ─────────────────────────────────────────────────────────────────────────────
 *  `withAgentLock` DEBE serializar la ejecución de `fn` por `(agentAddress,
 *  currency)`: dos invocaciones concurrentes con la misma pareja NUNCA pueden
 *  correr `fn` en paralelo.
 *
 *  **Sin esta garantía, el guardrail NO bloquea.** Dos `checkAndReserve`
 *  concurrentes del mismo agente leerían el mismo total de ventana y ambos
 *  reservarían → overcommit (el presupuesto se pasa de largo). Es exactamente
 *  el bug que se descubrió en producción y que motivó este contrato.
 *
 *  El adapter Postgres lo implementa con `pg_advisory_xact_lock`, que serializa
 *  por agente INCLUSO cuando no existe ninguna fila de `AgentBudgetRecord` (el
 *  caso default) — no se puede confiar en un `SELECT ... FOR UPDATE` sobre filas
 *  que pueden no existir.
 *
 *  Cualquier adapter nuevo DEBE pasar el test de concurrencia que viaja con el
 *  paquete antes de considerarse correcto.
 */
export interface BridleStorage {
  /**
   * Serializa `fn` por `(agentAddress, currency)`. Ver el contrato de arriba.
   * `fn` corre dentro de la sección crítica; el lock se libera al terminar
   * (resuelva o rechace).
   */
  withAgentLock<T>(
    agentAddress: string,
    currency: string,
    fn: () => Promise<T>,
  ): Promise<T>;

  /** Lee la política del agente para una moneda, o null si no tiene. */
  getBudget(agentAddress: string, currency: string): Promise<AgentBudgetRecord | null>;

  /**
   * Escribe (inserta o reemplaza) la política de un agente para una moneda.
   * Bridle es dueño del schema de `agent_budgets`, así que ofrece la API de
   * escritura: el host NO debe escribir SQL crudo contra la tabla interna.
   */
  upsertBudget(record: AgentBudgetRecord): Promise<void>;

  /**
   * Suma (escalada, `bigint`) de las entradas `reserved`+`committed` del agente
   * en la moneda, cuyo `windowStart >= windowFilterStart`.
   */
  sumActiveInWindow(
    agentAddress: string,
    currency: string,
    windowFilterStart: Date,
  ): Promise<bigint>;

  /**
   * Inserta una reserva nueva (status `reserved`).
   * Si ya existe una con ese `reservationId` → DEBE lanzar `ReservationConflictError`
   * (idempotencia: una reserva por id; nunca sobrescribir en silencio).
   */
  insertReservation(entry: LedgerEntry): Promise<void>;

  /**
   * Transición de estado de una reserva por `reservationId`.
   * Reglas (máquina de estados exclusiva):
   *  - `reserved → committed` y `reserved → released` son válidas.
   *  - `released → committed` es válida (carrera: el sweep liberó justo antes de
   *    que llegara el commit; el gasto es real y debe registrarse).
   *  - `committed → *` es no-op (un gasto confirmado no se revierte).
   * Idempotente: transicionar a un estado ya alcanzado es no-op.
   */
  transitionLedger(reservationId: string, to: Exclude<LedgerStatus, 'reserved'>): Promise<void>;

  /**
   * Mini-sweep inline: libera (`reserved → released`) las reservas EXPIRADAS de
   * UN agente+moneda (`expiresAt < now`). Se llama dentro de `withAgentLock`
   * antes de calcular el total, para no bloquear presupuesto con reservas zombis
   * del propio agente. Devuelve cuántas liberó.
   */
  releaseExpiredForAgent(agentAddress: string, currency: string, now: Date): Promise<number>;

  /**
   * Sweep global: libera TODAS las reservas expiradas (`reserved` con
   * `expiresAt < now`), de cualquier agente. Lo invoca `BridleGuard.expire()`.
   * Devuelve cuántas liberó.
   */
  releaseAllExpired(now: Date): Promise<number>;

  /**
   * Registra un nonce como usado. Si el nonce ya existe → DEBE lanzar (anti-replay).
   * `expiresAt` permite podarlo después.
   */
  consumeNonce(nonce: string, agentAddress: string, expiresAt: Date): Promise<void>;

  /** Poda nonces con `expiresAt < now`. Devuelve cuántos borró. */
  pruneExpiredNonces(now: Date): Promise<number>;
}
