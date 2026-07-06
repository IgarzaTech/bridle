/**
 * Tests del hook x402 para el Policy Engine (feature 0006, AC-11):
 *  - `mapBridleErrorToHttp` distingue política (403) de presupuesto (429).
 *  - `withBudget` propaga el `context` de gasto hacia `checkAndReserve`.
 */
import { withBudget, mapBridleErrorToHttp } from '../index';
import { BridleGuard } from '../../guard';
import { InMemoryStorage } from '../../in-memory-storage';
import {
  BudgetExceededError,
  PolicyDeniedError,
  PolicyInvalidError,
} from '../../errors';
import { POLICY_SCHEMA_VERSION, type PolicySet } from '../../policy/types';
import type { AgentBudgetRecord } from '../../types';

const AGENT = '0x2222222222222222222222222222222222222222';
const CUR = 'USDC';

function budget(overrides: Partial<AgentBudgetRecord> = {}): AgentBudgetRecord {
  return {
    agentAddress: AGENT,
    currency: CUR,
    windowDurationSeconds: 3600,
    maxAmountPerWindow: '100.00',
    maxAmountPerTx: null,
    unlimited: false,
    ...overrides,
  };
}

const allowGoodOnly: PolicySet = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  rules: [{ type: 'recipient', id: 'r1', allow: ['0xgood'] }],
};

describe('AC-11 — mapBridleErrorToHttp distingue política de presupuesto', () => {
  it('policy_denied → 403', () => {
    const res = mapBridleErrorToHttp(new PolicyDeniedError('recipient_not_allowed', 'r1', 'nope'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('policy_denied');
  });

  it('policy_invalid → 403', () => {
    const res = mapBridleErrorToHttp(new PolicyInvalidError('bad set', 'r1'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('policy_invalid');
  });

  it('budget_exceeded sigue siendo 429 (distinguible del 403 de política)', () => {
    const res = mapBridleErrorToHttp(new BudgetExceededError(3600));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('budget_exceeded');
  });
});

describe('AC-11 — withBudget propaga el context de gasto', () => {
  it('recipient permitido → paga y commit', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, allowGoodOnly);
    const g = new BridleGuard({ storage: s, config: {} });

    let paid = false;
    const result = await withBudget(
      g,
      {
        reservationId: 'p1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xgood' },
      },
      () => {
        paid = true;
        return Promise.resolve('ok');
      },
    );
    expect(result).toBe('ok');
    expect(paid).toBe(true);
    expect(s.getLedgerEntry('p1')?.status).toBe('committed');
  });

  it('recipient no permitido → PolicyDeniedError y payFn NUNCA corre', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, allowGoodOnly);
    const g = new BridleGuard({ storage: s, config: {} });

    let paid = false;
    await expect(
      withBudget(
        g,
        {
          reservationId: 'p2',
          agentAddress: AGENT,
          amount: '1.00',
          currency: CUR,
          context: { recipient: '0xstranger' },
        },
        () => {
          paid = true;
          return Promise.resolve('ok');
        },
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(paid).toBe(false);
    expect(s.getLedgerEntry('p2')).toBeUndefined();
  });
});
