import type { BridleStorage } from './storage';
import type { AgentBudgetRecord, LedgerEntry, LedgerStatus } from './types';
import { NonceAlreadyUsedError, ReservationConflictError } from './errors';

interface NonceRecord {
  agentAddress: string;
  expiresAt: Date;
}

/**
 * `InMemoryStorage` — test double de `BridleStorage`.
 *
 * TEST/DEMO ONLY. `withAgentLock` se serializa con un mutex en proceso (cadena de
 * promesas por `agente|moneda`), suficiente para los tests unitarios del core. NO
 * sirve para producción ni para concurrencia entre procesos — para eso está el
 * adapter Postgres (`pg_advisory_xact_lock`).
 */
export class InMemoryStorage implements BridleStorage {
  private readonly budgets = new Map<string, AgentBudgetRecord>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly nonces = new Map<string, NonceRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();

  private key(agentAddress: string, currency: string): string {
    return `${agentAddress.toLowerCase()}|${currency}`;
  }

  /** Helper de tests (sync): registra una política de presupuesto. */
  setBudget(budget: AgentBudgetRecord): void {
    this.budgets.set(this.key(budget.agentAddress, budget.currency), budget);
  }

  upsertBudget(record: AgentBudgetRecord): Promise<void> {
    this.budgets.set(this.key(record.agentAddress, record.currency), record);
    return Promise.resolve();
  }

  /** Helper de tests: lee una entrada del ledger por id. */
  getLedgerEntry(reservationId: string): LedgerEntry | undefined {
    return this.ledger.get(reservationId);
  }

  async withAgentLock<T>(
    agentAddress: string,
    currency: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const k = this.key(agentAddress, currency);
    const prev = this.locks.get(k) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.locks.set(k, prev.then(() => current));
    await prev;
    try {
      return await fn();
    } finally {
      releaseCurrent();
    }
  }

  getBudget(agentAddress: string, currency: string): Promise<AgentBudgetRecord | null> {
    return Promise.resolve(this.budgets.get(this.key(agentAddress, currency)) ?? null);
  }

  sumActiveInWindow(
    agentAddress: string,
    currency: string,
    windowFilterStart: Date,
  ): Promise<bigint> {
    let total = 0n;
    for (const e of this.ledger.values()) {
      if (
        e.agentAddress.toLowerCase() === agentAddress.toLowerCase() &&
        e.currency === currency &&
        (e.status === 'reserved' || e.status === 'committed') &&
        e.windowStart.getTime() >= windowFilterStart.getTime()
      ) {
        total += e.amountScaled;
      }
    }
    return Promise.resolve(total);
  }

  insertReservation(entry: LedgerEntry): Promise<void> {
    if (this.ledger.has(entry.reservationId)) {
      return Promise.reject(new ReservationConflictError(entry.reservationId));
    }
    this.ledger.set(entry.reservationId, { ...entry });
    return Promise.resolve();
  }

  transitionLedger(reservationId: string, to: Exclude<LedgerStatus, 'reserved'>): Promise<void> {
    const e = this.ledger.get(reservationId);
    if (!e) return Promise.resolve();
    if (to === 'committed') {
      // reserved | released → committed; committed → no-op.
      if (e.status !== 'committed') e.status = 'committed';
    } else {
      // 'released': solo desde reserved; committed/released → no-op.
      if (e.status === 'reserved') e.status = 'released';
    }
    return Promise.resolve();
  }

  releaseExpiredForAgent(agentAddress: string, currency: string, now: Date): Promise<number> {
    let n = 0;
    for (const e of this.ledger.values()) {
      if (
        e.agentAddress.toLowerCase() === agentAddress.toLowerCase() &&
        e.currency === currency &&
        e.status === 'reserved' &&
        e.expiresAt.getTime() < now.getTime()
      ) {
        e.status = 'released';
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  releaseAllExpired(now: Date): Promise<number> {
    let n = 0;
    for (const e of this.ledger.values()) {
      if (e.status === 'reserved' && e.expiresAt.getTime() < now.getTime()) {
        e.status = 'released';
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  consumeNonce(nonce: string, agentAddress: string, expiresAt: Date): Promise<void> {
    if (this.nonces.has(nonce)) {
      return Promise.reject(new NonceAlreadyUsedError());
    }
    this.nonces.set(nonce, { agentAddress, expiresAt });
    return Promise.resolve();
  }

  pruneExpiredNonces(now: Date): Promise<number> {
    let n = 0;
    for (const [nonce, rec] of this.nonces.entries()) {
      if (rec.expiresAt.getTime() < now.getTime()) {
        this.nonces.delete(nonce);
        n += 1;
      }
    }
    return Promise.resolve(n);
  }
}
