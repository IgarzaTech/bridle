import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { BridleStorage } from '../storage';
import type { AgentBudgetRecord, LedgerEntry, LedgerStatus } from '../types';
import { NonceAlreadyUsedError, ReservationConflictError } from '../errors';
import { formatAmount, parseAmount } from '../amount';
import {
  createSchemaSql,
  dropSchemaSql,
  qualifiedTable,
  type SchemaNaming,
} from './schema';

const PG_UNIQUE_VIOLATION = '23505';

interface BudgetRow extends QueryResultRow {
  window_duration_seconds: number;
  max_amount_per_window: string;
  max_amount_per_tx: string | null;
  unlimited: boolean;
}

interface SumRow extends QueryResultRow {
  total: string;
}

/**
 * `PostgresStorageAdapter` — implementación de `BridleStorage` sobre Postgres.
 *
 * `withAgentLock` usa `pg_advisory_xact_lock`, que serializa por agente INCLUSO
 * cuando no existe fila de presupuesto (el caso default). Las operaciones que el
 * core ejecuta dentro de `withAgentLock` corren en la MISMA conexión/transacción
 * que tomó el lock, propagada vía `AsyncLocalStorage` (sin cambiar la interfaz).
 *
 * El host provee el `pg.Pool` (Bridle no lo crea — no se acopla a TypeORM ni a
 * ninguna config de DB).
 */
export class PostgresStorageAdapter implements BridleStorage {
  private readonly txClient = new AsyncLocalStorage<PoolClient>();
  private readonly naming: SchemaNaming;

  constructor(
    private readonly pool: Pool,
    naming: SchemaNaming = {},
  ) {
    this.naming = naming;
  }

  /** Crea las tablas (idempotente). El host puede usarlo o aplicar su propia migración. */
  async migrate(): Promise<void> {
    await this.pool.query(createSchemaSql(this.naming));
  }

  /** Borra las tablas (para limpieza de tests). */
  async dropSchema(): Promise<void> {
    await this.pool.query(dropSchemaSql(this.naming));
  }

  private table(name: string): string {
    return qualifiedTable(name, this.naming);
  }

  private query<R extends QueryResultRow>(
    sql: string,
    params: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>> {
    const client = this.txClient.getStore();
    // why: el tipo de `values` en @types/pg es `any[]`; pasamos unknown[] de forma
    // segura (los valores son strings/dates/numbers serializables por el driver).
    const values = params as unknown[];
    return client ? client.query<R>(sql, values) : this.pool.query<R>(sql, values);
  }

  async withAgentLock<T>(
    agentAddress: string,
    currency: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // why: hashtext() devuelve int4 (32 bits), así que dos pares (agente, moneda)
      // distintos PODRÍAN colisionar al mismo advisory lock → falsa contención (se
      // serializan de más). NO rompe la correctitud (nunca permite overcommit; a lo
      // sumo serializa dos agentes no relacionados de vez en cuando). Si la
      // contención fuese un problema a gran escala, usar dos claves int4 con
      // pg_advisory_xact_lock(int4, int4) o un hash de 64 bits.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `bridle:${agentAddress.toLowerCase()}:${currency}`,
      ]);
      const result = await this.txClient.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertBudget(record: AgentBudgetRecord): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('agent_budgets')}
        (agent_address, currency, window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_address, currency) DO UPDATE SET
         window_duration_seconds = EXCLUDED.window_duration_seconds,
         max_amount_per_window = EXCLUDED.max_amount_per_window,
         max_amount_per_tx = EXCLUDED.max_amount_per_tx,
         unlimited = EXCLUDED.unlimited`,
      [
        record.agentAddress.toLowerCase(),
        record.currency,
        record.windowDurationSeconds,
        parseAmount(record.maxAmountPerWindow).toString(),
        record.maxAmountPerTx !== null ? parseAmount(record.maxAmountPerTx).toString() : null,
        record.unlimited,
      ],
    );
  }

  async getBudget(agentAddress: string, currency: string): Promise<AgentBudgetRecord | null> {
    const res = await this.query<BudgetRow>(
      `SELECT window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited
       FROM ${this.table('agent_budgets')}
       WHERE agent_address = $1 AND currency = $2`,
      [agentAddress.toLowerCase(), currency],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      agentAddress: agentAddress.toLowerCase(),
      currency,
      windowDurationSeconds: row.window_duration_seconds,
      maxAmountPerWindow: formatAmount(BigInt(row.max_amount_per_window)),
      maxAmountPerTx: row.max_amount_per_tx !== null ? formatAmount(BigInt(row.max_amount_per_tx)) : null,
      unlimited: row.unlimited,
    };
  }

  async sumActiveInWindow(
    agentAddress: string,
    currency: string,
    windowFilterStart: Date,
  ): Promise<bigint> {
    const res = await this.query<SumRow>(
      `SELECT COALESCE(SUM(amount_scaled), 0)::text AS total
       FROM ${this.table('budget_ledger')}
       WHERE agent_address = $1 AND currency = $2
         AND status IN ('reserved', 'committed')
         AND window_start >= $3`,
      [agentAddress.toLowerCase(), currency, windowFilterStart.toISOString()],
    );
    return BigInt(res.rows[0]?.total ?? '0');
  }

  async insertReservation(entry: LedgerEntry): Promise<void> {
    try {
      await this.query(
        `INSERT INTO ${this.table('budget_ledger')}
          (reservation_id, agent_address, currency, amount_scaled, status, window_start, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.reservationId,
          entry.agentAddress.toLowerCase(),
          entry.currency,
          entry.amountScaled.toString(),
          entry.status,
          entry.windowStart.toISOString(),
          entry.expiresAt.toISOString(),
        ],
      );
    } catch (err) {
      // PK violation sobre reservation_id → reservationId duplicado.
      if (isUniqueViolation(err)) {
        throw new ReservationConflictError(entry.reservationId);
      }
      throw err;
    }
  }

  async transitionLedger(
    reservationId: string,
    to: Exclude<LedgerStatus, 'reserved'>,
  ): Promise<void> {
    if (to === 'committed') {
      // reserved | released → committed; committed se queda igual (no-op).
      await this.query(
        `UPDATE ${this.table('budget_ledger')} SET status = 'committed'
         WHERE reservation_id = $1 AND status IN ('reserved', 'released')`,
        [reservationId],
      );
    } else {
      // released: solo desde reserved; committed/released → no-op.
      await this.query(
        `UPDATE ${this.table('budget_ledger')} SET status = 'released'
         WHERE reservation_id = $1 AND status = 'reserved'`,
        [reservationId],
      );
    }
  }

  async releaseExpiredForAgent(
    agentAddress: string,
    currency: string,
    now: Date,
  ): Promise<number> {
    const res = await this.query(
      `UPDATE ${this.table('budget_ledger')} SET status = 'released'
       WHERE agent_address = $1 AND currency = $2 AND status = 'reserved' AND expires_at < $3`,
      [agentAddress.toLowerCase(), currency, now.toISOString()],
    );
    return res.rowCount ?? 0;
  }

  async releaseAllExpired(now: Date): Promise<number> {
    const res = await this.query(
      `UPDATE ${this.table('budget_ledger')} SET status = 'released'
       WHERE status = 'reserved' AND expires_at < $1`,
      [now.toISOString()],
    );
    return res.rowCount ?? 0;
  }

  async consumeNonce(nonce: string, agentAddress: string, expiresAt: Date): Promise<void> {
    try {
      await this.query(
        `INSERT INTO ${this.table('used_nonces')} (nonce, agent_address, expires_at)
         VALUES ($1, $2, $3)`,
        [nonce, agentAddress.toLowerCase(), expiresAt.toISOString()],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new NonceAlreadyUsedError();
      }
      throw err;
    }
  }

  async pruneExpiredNonces(now: Date): Promise<number> {
    const res = await this.query(
      `DELETE FROM ${this.table('used_nonces')} WHERE expires_at < $1`,
      [now.toISOString()],
    );
    return res.rowCount ?? 0;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

export { createSchemaSql, dropSchemaSql, type SchemaNaming } from './schema';
