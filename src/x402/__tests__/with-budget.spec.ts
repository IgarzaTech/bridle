import { withBudget, withBudgetRail, mapBridleErrorToHttp } from '../index';
import type { PaymentRail } from '../index';
import { BridleGuard } from '../../guard';
import { InMemoryStorage } from '../../in-memory-storage';
import type { SignatureVerifier } from '../../signature-verifier';
import type { AgentBudgetRecord } from '../../types';
import {
  AmountExceedsPerTxLimitError,
  BudgetExceededError,
  BudgetPolicyNotConfiguredError,
  IdentityMismatchError,
  InvalidAmountError,
  NonceAlreadyUsedError,
  NonceTooOldError,
  ReservationConflictError,
} from '../../errors';

const AGENT = '0x2222222222222222222222222222222222222222';
const CUR = 'USDC';
const dummyVerifier: SignatureVerifier = { recover: () => Promise.resolve('0x0') };

function budget(overrides: Partial<AgentBudgetRecord> = {}): AgentBudgetRecord {
  return {
    agentAddress: AGENT,
    currency: CUR,
    windowDurationSeconds: 3600,
    maxAmountPerWindow: '1.00',
    maxAmountPerTx: null,
    unlimited: false,
    ...overrides,
  };
}

function makeGuard(storage: InMemoryStorage): BridleGuard {
  return new BridleGuard({ storage, signatureVerifier: dummyVerifier, config: {} });
}

const attempt = { reservationId: 'p1', agentAddress: AGENT, amount: '1.00', currency: CUR };

describe('withBudget (AC-6)', () => {
  it('paga y hace commit cuando hay presupuesto', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '5.00' }));
    const g = makeGuard(s);

    const result = await withBudget(g, attempt, () => Promise.resolve('paid'));
    expect(result).toBe('paid');
    expect(s.getLedgerEntry('p1')?.status).toBe('committed');
  });

  it('DENY por presupuesto → NO ejecuta payFn (no se paga)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '0.50' }));
    const g = makeGuard(s);

    const payFn = jest.fn(() => Promise.resolve('paid'));
    await expect(withBudget(g, attempt, payFn)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(payFn).not.toHaveBeenCalled();
    expect(s.getLedgerEntry('p1')).toBeUndefined();
  });

  it('si el pago falla → release de la reserva y re-lanza', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '5.00' }));
    const g = makeGuard(s);

    const payErr = new Error('rail down');
    await expect(withBudget(g, attempt, () => Promise.reject(payErr))).rejects.toBe(payErr);
    expect(s.getLedgerEntry('p1')?.status).toBe('released');
  });

  it('withBudgetRail envuelve un PaymentRail del host', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '5.00' }));
    const g = makeGuard(s);

    const rail: PaymentRail<string> = { pay: () => Promise.resolve('settled') };
    const result = await withBudgetRail(g, attempt, rail);
    expect(result).toBe('settled');
    expect(s.getLedgerEntry('p1')?.status).toBe('committed');
  });
});

describe('mapBridleErrorToHttp (adapter Express)', () => {
  it('mapea cada error de Bridle a su código HTTP', () => {
    expect(mapBridleErrorToHttp(new BudgetExceededError(3600)).status).toBe(429);
    expect(mapBridleErrorToHttp(new BudgetExceededError(3600)).body.retryAfterSeconds).toBe(3600);
    expect(mapBridleErrorToHttp(new AmountExceedsPerTxLimitError()).status).toBe(429);
    expect(mapBridleErrorToHttp(new BudgetPolicyNotConfiguredError()).status).toBe(503);
    expect(mapBridleErrorToHttp(new IdentityMismatchError()).status).toBe(403);
    expect(mapBridleErrorToHttp(new NonceTooOldError()).status).toBe(422);
    expect(mapBridleErrorToHttp(new NonceAlreadyUsedError()).status).toBe(409);
    expect(mapBridleErrorToHttp(new ReservationConflictError('r1')).status).toBe(409);
    expect(mapBridleErrorToHttp(new InvalidAmountError()).status).toBe(400);
  });
});
