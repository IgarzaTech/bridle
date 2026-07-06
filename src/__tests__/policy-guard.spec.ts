/**
 * Tests de integración del Policy Engine dentro de `BridleGuard.checkAndReserve`
 * (feature 0006). Cubre AC-2, AC-3, AC-4, AC-5 (independencia de categoría, sin DB),
 * AC-6, AC-7, AC-9, AC-11.
 */
import { BridleGuard } from '../guard';
import { InMemoryStorage } from '../in-memory-storage';
import { PolicyDeniedError, PolicyInvalidError, BudgetExceededError } from '../errors';
import {
  POLICY_SCHEMA_VERSION,
  type PolicyAuditEvent,
  type PolicyAuditSink,
  type PolicyRule,
  type PolicySet,
} from '../policy/types';
import type { AgentBudgetRecord, BridleConfig } from '../types';
import type { BridleStorage } from '../storage';

const AGENT = '0x1111111111111111111111111111111111111111';
const CUR = 'USDC';

function budget(overrides: Partial<AgentBudgetRecord> = {}): AgentBudgetRecord {
  return {
    agentAddress: AGENT,
    currency: CUR,
    windowDurationSeconds: 3600,
    maxAmountPerWindow: '1000.00',
    maxAmountPerTx: null,
    unlimited: false,
    ...overrides,
  };
}

function policySet(rules: PolicyRule[]): PolicySet {
  return { schemaVersion: POLICY_SCHEMA_VERSION, rules };
}

function makeGuard(storage: InMemoryStorage, config: BridleConfig = {}): BridleGuard {
  return new BridleGuard({ storage, config });
}

/** Sink que graba la secuencia de eventos para asserts de orden (AC-9). */
function recordingSink(): { sink: PolicyAuditSink; events: PolicyAuditEvent[] } {
  const events: PolicyAuditEvent[] = [];
  return { events, sink: { record: (e) => events.push(e) } };
}

// ── AC-3: allowlist de recipients ─────────────────────────────────────────────

describe('AC-3 — allowlist de recipients', () => {
  it('recipient listado → continúa al presupuesto (reserva)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xGOOD'] }]));
    const g = makeGuard(s);

    await g.checkAndReserve({
      reservationId: 'r1',
      agentAddress: AGENT,
      amount: '1.00',
      currency: CUR,
      context: { recipient: '0xgood' },
    });
    expect(s.getLedgerEntry('r1')?.status).toBe('reserved');
  });

  it('recipient NO listado → PolicyDeniedError, sin reserva', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xgood'] }]));
    const g = makeGuard(s);

    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xstranger' },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied', reasonCode: 'recipient_not_allowed' });
    expect(s.getLedgerEntry('r1')).toBeUndefined();
  });
});

// ── AC-2: deny no inserta reserva; sumActiveInWindow no cambia ─────────────────

describe('AC-2 — deny por política no inserta reserva', () => {
  it('tras un deny, sumActiveInWindow no cambia', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', deny: ['0xbad'] }]));
    const g = makeGuard(s);

    const before = await s.sumActiveInWindow(AGENT, CUR, new Date(0));
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xbad' },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const after = await s.sumActiveInWindow(AGENT, CUR, new Date(0));
    expect(after).toBe(before);
    expect(after).toBe(0n);
  });
});

// ── AC-4: precedencia deny > allow, independiente del orden del array ─────────

describe('AC-4 — precedencia deny > allow e independencia de orden', () => {
  const inBoth: PolicyRule[] = [
    { type: 'recipient', id: 'allow-rule', allow: ['0xoverlap'] },
    { type: 'recipient', id: 'deny-rule', deny: ['0xoverlap'] },
  ];

  it('recipient en deny Y allow → deny', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet(inBoth));
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xoverlap' },
      }),
    ).rejects.toMatchObject({ reasonCode: 'recipient_denied' });
  });

  it('permutar el orden de las reglas produce la misma decisión (deny)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([...inBoth].reverse()));
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({
        reservationId: 'r2',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xoverlap' },
      }),
    ).rejects.toMatchObject({ reasonCode: 'recipient_denied' });
  });
});

// ── AC-5: límite por categoría, independencia entre categorías (sin DB) ────────

describe('AC-5 — límite por categoría independiente y bigint exacto', () => {
  const catRule: PolicyRule = {
    type: 'category',
    id: 'cap-cloud',
    category: 'cloud',
    maxAmountPerWindow: '1.00',
    windowDurationSeconds: 3600,
  };
  const catRuleData: PolicyRule = {
    type: 'category',
    id: 'cap-data',
    category: 'data',
    maxAmountPerWindow: '1.00',
    windowDurationSeconds: 3600,
  };

  it('gasto en A no consume el cupo de B; ambos consumen el global', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '10.00' }));
    s.setPolicySet(AGENT, CUR, policySet([catRule, catRuleData]));
    const g = makeGuard(s);

    // Llena "cloud" hasta su cupo (1.00).
    await g.checkAndReserve({
      reservationId: 'c1',
      agentAddress: AGENT,
      amount: '1.00',
      currency: CUR,
      context: { category: 'cloud' },
    });
    // Otra en "cloud" excede SU límite → deny por categoría.
    await expect(
      g.checkAndReserve({
        reservationId: 'c2',
        agentAddress: AGENT,
        amount: '0.01',
        currency: CUR,
        context: { category: 'cloud' },
      }),
    ).rejects.toMatchObject({ reasonCode: 'category_limit_exceeded' });
    // Pero "data" tiene su propio cupo intacto → pasa.
    await g.checkAndReserve({
      reservationId: 'd1',
      agentAddress: AGENT,
      amount: '1.00',
      currency: CUR,
      context: { category: 'data' },
    });
    expect(s.getLedgerEntry('d1')?.status).toBe('reserved');
    // El global (10.00) sigue vivo: cloud(1) + data(1) = 2 committed/reserved.
    expect(await s.sumActiveInWindow(AGENT, CUR, new Date(0))).toBe(2_000_000n);
  });

  it('per-tx por categoría', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(
      AGENT,
      CUR,
      policySet([{ type: 'category', id: 'cap', category: 'cloud', maxAmountPerTx: '0.50' }]),
    );
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({
        reservationId: 'x',
        agentAddress: AGENT,
        amount: '0.51',
        currency: CUR,
        context: { category: 'cloud' },
      }),
    ).rejects.toMatchObject({ reasonCode: 'category_per_tx_exceeded' });
  });

  it('categoría denegada (allow:false) → deny', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(
      AGENT,
      CUR,
      policySet([{ type: 'category', id: 'no-gambling', category: 'gambling', allow: false }]),
    );
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({
        reservationId: 'x',
        agentAddress: AGENT,
        amount: '0.01',
        currency: CUR,
        context: { category: 'gambling' },
      }),
    ).rejects.toMatchObject({ reasonCode: 'category_denied' });
  });
});

// ── AC-6: ventana temporal con TZ explícita, reloj inyectable ─────────────────

describe('AC-6 — ventana temporal con TZ explícita (reloj inyectable)', () => {
  const nineToFiveNY: PolicyRule = {
    type: 'timeWindow',
    id: 'business-hours',
    timezone: 'America/New_York',
    startMinute: 9 * 60,
    endMinute: 17 * 60,
  };

  function at(iso: string): Date {
    return new Date(iso);
  }

  it('dentro de la franja → allow', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([nineToFiveNY]));
    const g = makeGuard(s);
    // 2026-07-02 14:00 UTC = 10:00 America/New_York (EDT, UTC-4) → dentro.
    await g.checkAndReserve(
      { reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR },
      at('2026-07-02T14:00:00Z'),
    );
    expect(s.getLedgerEntry('r1')?.status).toBe('reserved');
  });

  it('fuera de la franja → deny', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([nineToFiveNY]));
    const g = makeGuard(s);
    // 2026-07-02 03:00 UTC = 23:00 (día anterior) NY → fuera.
    await expect(
      g.checkAndReserve(
        { reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR },
        at('2026-07-02T03:00:00Z'),
      ),
    ).rejects.toMatchObject({ reasonCode: 'outside_time_window' });
  });

  it('borde exacto: inicio de franja incluido, fin excluido', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([nineToFiveNY]));
    const g = makeGuard(s);
    // 13:00 UTC = 09:00 NY exacto → dentro (inicio incluido).
    await g.checkAndReserve(
      { reservationId: 'start', agentAddress: AGENT, amount: '1.00', currency: CUR },
      at('2026-07-02T13:00:00Z'),
    );
    expect(s.getLedgerEntry('start')?.status).toBe('reserved');
    // 21:00 UTC = 17:00 NY exacto → fuera (fin excluido).
    await expect(
      g.checkAndReserve(
        { reservationId: 'end', agentAddress: AGENT, amount: '1.00', currency: CUR },
        at('2026-07-02T21:00:00Z'),
      ),
    ).rejects.toMatchObject({ reasonCode: 'outside_time_window' });
  });

  it('cruce de medianoche (22:00→06:00 UTC): dentro tras medianoche', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(
      AGENT,
      CUR,
      policySet([
        { type: 'timeWindow', id: 'night', timezone: 'UTC', startMinute: 22 * 60, endMinute: 6 * 60 },
      ]),
    );
    const g = makeGuard(s);
    // 02:00 UTC → dentro (madrugada, tras el cruce).
    await g.checkAndReserve(
      { reservationId: 'night1', agentAddress: AGENT, amount: '1.00', currency: CUR },
      at('2026-07-02T02:00:00Z'),
    );
    expect(s.getLedgerEntry('night1')?.status).toBe('reserved');
    // 12:00 UTC → fuera (mediodía).
    await expect(
      g.checkAndReserve(
        { reservationId: 'noon', agentAddress: AGENT, amount: '1.00', currency: CUR },
        at('2026-07-02T12:00:00Z'),
      ),
    ).rejects.toMatchObject({ reasonCode: 'outside_time_window' });
  });
});

// ── AC-7: fail-safe ───────────────────────────────────────────────────────────

describe('AC-7 — fail-safe', () => {
  it('(a) tipo de regla desconocido → PolicyInvalidError (deny)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'wormhole', id: 'w1' } as unknown as PolicyRule]));
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR }),
    ).rejects.toBeInstanceOf(PolicyInvalidError);
    expect(s.getLedgerEntry('r1')).toBeUndefined();
  });

  it('(b) política referencia recipient ausente en el contexto → PolicyInvalidError', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xgood'] }]));
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        // sin context.recipient
      }),
    ).rejects.toMatchObject({ code: 'policy_invalid' });
    expect(s.getLedgerEntry('r1')).toBeUndefined();
  });

  it('(b) política de categoría con category ausente → PolicyInvalidError', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(
      AGENT,
      CUR,
      policySet([{ type: 'category', id: 'c1', category: 'cloud', maxAmountPerTx: '1.00' }]),
    );
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR }),
    ).rejects.toBeInstanceOf(PolicyInvalidError);
  });

  it('(c) adapter SIN sumActiveInWindowByCategory + límite de ventana por categoría → PolicyInvalidError, sin reserva', async () => {
    // Storage-double: delega a un InMemoryStorage pero NO expone
    // sumActiveInWindowByCategory (simula un adapter de terceros que no lo implementó).
    // Fail-safe: un límite por categoría con un adapter que no sabe sumar por categoría
    // debe DENEGAR — nunca un allow silencioso (si el guard borrara esa rama, este test
    // fallaría en vez de dejar pasar el gasto).
    const inner = new InMemoryStorage();
    inner.setBudget(budget());
    inner.setPolicySet(
      AGENT,
      CUR,
      policySet([
        {
          type: 'category',
          id: 'cap-cloud',
          category: 'cloud',
          maxAmountPerWindow: '1.00',
          windowDurationSeconds: 3600,
        },
      ]),
    );

    // why: construimos el double implementando BridleStorage a mano y OMITIENDO el
    // método opcional, en vez de setearlo a undefined sobre una clase.
    const storageWithoutCategorySum: BridleStorage = {
      withAgentLock: (a, c, fn) => inner.withAgentLock(a, c, fn),
      getBudget: (a, c) => inner.getBudget(a, c),
      upsertBudget: (r) => inner.upsertBudget(r),
      sumActiveInWindow: (a, c, w) => inner.sumActiveInWindow(a, c, w),
      insertReservation: (e) => inner.insertReservation(e),
      transitionLedger: (id, to) => inner.transitionLedger(id, to),
      releaseExpiredForAgent: (a, c, n) => inner.releaseExpiredForAgent(a, c, n),
      releaseAllExpired: (n) => inner.releaseAllExpired(n),
      consumeNonce: (n, a, e) => inner.consumeNonce(n, a, e),
      pruneExpiredNonces: (n) => inner.pruneExpiredNonces(n),
      getPolicySet: (a, c) => inner.getPolicySet(a, c),
      // sumActiveInWindowByCategory: OMITIDO a propósito.
    };
    expect(storageWithoutCategorySum.sumActiveInWindowByCategory).toBeUndefined();

    const g = new BridleGuard({ storage: storageWithoutCategorySum, config: {} });
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '0.10',
        currency: CUR,
        context: { category: 'cloud' },
      }),
    ).rejects.toBeInstanceOf(PolicyInvalidError);
    // No se insertó reserva (deny fail-safe, no allow silencioso).
    expect(inner.getLedgerEntry('r1')).toBeUndefined();
  });
});

// ── AC-9 (robustez): un sink que lanza NO puede romper el flujo ────────────────

describe('AC-9 — el sink de auditoría es best-effort (nunca rompe el flujo)', () => {
  const throwingSink: PolicyAuditSink = {
    record() {
      throw new Error('sink boom (host logging failed)');
    },
  };

  it('(a) allow dentro de presupuesto: la reserva IGUAL se inserta y no rechaza', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xgood'] }]));
    const g = makeGuard(s, { auditSink: throwingSink });

    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xgood' },
      }),
    ).resolves.toBeUndefined();
    // El gasto legítimo se registró pese al sink que lanza.
    expect(s.getLedgerEntry('r1')?.status).toBe('reserved');
  });

  it('(b) deny por política: IGUAL deniega con el error de política, NO con el del sink', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', deny: ['0xbad'] }]));
    const g = makeGuard(s, { auditSink: throwingSink });

    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xbad' },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError); // no el Error del sink
    expect(s.getLedgerEntry('r1')).toBeUndefined();
  });
});

// ── AC-9: auditoría ────────────────────────────────────────────────────────────

describe('AC-9 — auditoría de decisiones', () => {
  it('allow y deny invocan el sink con reasonCode + ruleId, en orden', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(
      AGENT,
      CUR,
      policySet([{ type: 'recipient', id: 'gate', allow: ['0xgood'], deny: ['0xbad'] }]),
    );
    const { sink, events } = recordingSink();
    const g = makeGuard(s, { auditSink: sink });

    // 1) allow
    await g.checkAndReserve({
      reservationId: 'a1',
      agentAddress: AGENT,
      amount: '1.00',
      currency: CUR,
      context: { recipient: '0xgood' },
    });
    // 2) deny (denylist)
    await g
      .checkAndReserve({
        reservationId: 'a2',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xbad' },
      })
      .catch(() => undefined);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      reservationId: 'a1',
      decision: { allowed: true, reasonCode: 'allow' },
    });
    expect(events[1]).toMatchObject({
      reservationId: 'a2',
      decision: { allowed: false, reasonCode: 'recipient_denied', ruleId: 'gate' },
    });
  });

  it('sink default es no-op (no lanza, sin efectos)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xgood'] }]));
    const g = makeGuard(s); // sin auditSink → noop
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xgood' },
      }),
    ).resolves.toBeUndefined();
  });
});

// ── AC-8 (positivo): defaultPolicySet vía config + presupuesto sigue aplicando ──

describe('AC-8/AC-11 — origen del PolicySet y combinación con presupuesto', () => {
  it('defaultPolicySet vía config aplica cuando el storage no trae set propio', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    const g = makeGuard(s, {
      defaultPolicySet: policySet([{ type: 'recipient', id: 'r1', deny: ['0xbad'] }]),
    });
    await expect(
      g.checkAndReserve({
        reservationId: 'r1',
        agentAddress: AGENT,
        amount: '1.00',
        currency: CUR,
        context: { recipient: '0xbad' },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('política allow pero presupuesto agotado → BudgetExceededError (política pasó, budget no)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '1.00' }));
    s.setPolicySet(AGENT, CUR, policySet([{ type: 'recipient', id: 'r1', allow: ['0xgood'] }]));
    const g = makeGuard(s);
    await g.checkAndReserve({
      reservationId: 'r1',
      agentAddress: AGENT,
      amount: '1.00',
      currency: CUR,
      context: { recipient: '0xgood' },
    });
    await expect(
      g.checkAndReserve({
        reservationId: 'r2',
        agentAddress: AGENT,
        amount: '0.01',
        currency: CUR,
        context: { recipient: '0xgood' },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
