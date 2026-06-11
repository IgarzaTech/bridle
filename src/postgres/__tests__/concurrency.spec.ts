/**
 * Test de concurrencia REAL contra Postgres (AC-9) — la garantía central del wedge:
 * "el presupuesto bloquea de verdad". Sin la serialización de `withAgentLock`
 * (pg_advisory_xact_lock), N reservas concurrentes harían overcommit.
 *
 * Aislamiento: usa el prefijo de tabla `bridle_test_` para NO chocar con las tablas
 * que NexoPay (0003) crea en el mismo Postgres del CI durante la ventana 0004→0005.
 *
 * Gated por DATABASE_HOST — se omite si no hay Postgres (no rompe init.sh local).
 */
import { Pool } from 'pg';
import { BridleGuard } from '../../guard';
import { PostgresStorageAdapter } from '../index';
import type { SignatureVerifier } from '../../signature-verifier';
import { parseAmount } from '../../amount';
import { ReservationConflictError } from '../../errors';

const HAS_DB = !!process.env.DATABASE_HOST;
// GitHub Actions setea CI='true'; Azure DevOps setea TF_BUILD='True'. En cualquier CI
// este test NO puede skippear: la garantía de que "el presupuesto bloquea" debe
// validarse de verdad. Gate genérico para no atarse a un proveedor de CI.
const IN_CI = !!process.env.CI || process.env.TF_BUILD === 'True';

const CUR = 'USDC';
const AMOUNT = '1.00';
const N = 20;

const dummyVerifier: SignatureVerifier = { recover: () => Promise.resolve('0x0') };

// GATE: CI sin DATABASE_HOST → FALLA (no skip). Skippear solo es válido en local.
if (IN_CI && !HAS_DB) {
  describe('PostgresStorageAdapter — concurrencia real (AC-9) — GATE CI', () => {
    it('DEBE ejecutarse en CI: DATABASE_HOST ausente → la garantía NO se validó', () => {
      throw new Error(
        'CI sin DATABASE_HOST: el test de concurrencia (la garantía de que el presupuesto ' +
          'bloquea de verdad) no se ejecutó. Configura DATABASE_HOST/PORT/USER/PASSWORD/NAME ' +
          'en el pipeline para que apunten al Postgres del CI. Skippear solo es válido en local.',
      );
    });
  });
}

(HAS_DB ? describe : describe.skip)('PostgresStorageAdapter — concurrencia real (AC-9)', () => {
  let pool: Pool;
  let adapter: PostgresStorageAdapter;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
      user: process.env.DATABASE_USER ?? 'nexopay',
      password: process.env.DATABASE_PASSWORD ?? '',
      database: process.env.DATABASE_NAME ?? 'nexopay_test',
    });
    adapter = new PostgresStorageAdapter(pool, { tablePrefix: 'bridle_test_' });
    await adapter.dropSchema().catch(() => undefined);
    await adapter.migrate();
  });

  afterAll(async () => {
    if (adapter) await adapter.dropSchema().catch(() => undefined);
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bridle_test_budget_ledger');
    await pool.query('DELETE FROM bridle_test_agent_budgets');
  });

  async function fireConcurrent(
    guard: BridleGuard,
    agentAddress: string,
  ): Promise<{ ok: number; deny: number; other: unknown[] }> {
    const calls = Array.from({ length: N }, (_v, i) =>
      guard.checkAndReserve({
        reservationId: `${agentAddress}-${i}`,
        agentAddress,
        amount: AMOUNT,
        currency: CUR,
      }),
    );
    const results = await Promise.allSettled(calls);
    let ok = 0;
    let deny = 0;
    const other: unknown[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') ok += 1;
      else if ((r.reason as { code?: string })?.code === 'budget_exceeded') deny += 1;
      else other.push(r.reason);
    }
    return { ok, deny, other };
  }

  async function totalReserved(agentAddress: string): Promise<bigint> {
    return adapter.sumActiveInWindow(agentAddress, CUR, new Date(0));
  }

  it('Caso A — con AgentBudget: exactamente 1 pasa, resto deny, total == presupuesto', async () => {
    const agent = '0xaaaa000000000000000000000000000000000001';
    // Fila con límite 1.00. El default del guard es ALTO (999.00): si por error el
    // código usara el default en vez de la fila, TODAS pasarían y el test fallaría.
    await pool.query(
      `INSERT INTO bridle_test_agent_budgets
        (agent_address, currency, window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited)
       VALUES ($1, $2, $3, $4, NULL, false)`,
      [agent, CUR, 3600, parseAmount('1.00').toString()],
    );
    const guard = new BridleGuard({
      storage: adapter,
      signatureVerifier: dummyVerifier,
      config: { defaultBudget: { maxAmountPerWindow: '999.00', windowDurationSeconds: 3600 } },
    });

    const { ok, deny, other } = await fireConcurrent(guard, agent);
    expect(other).toEqual([]);
    expect(ok).toBe(1);
    expect(deny).toBe(N - 1);
    expect(await totalReserved(agent)).toBe(parseAmount('1.00')); // nunca > presupuesto
  });

  it('Caso B — SIN fila (defaults), el caso crítico: exactamente 1 pasa, resto deny, total == presupuesto', async () => {
    // Sin fila en agent_budgets → usa el default budget. Aquí el advisory lock es
    // imprescindible: un SELECT FOR UPDATE no tendría fila que lockear.
    const agent = '0xbbbb000000000000000000000000000000000002';
    const guard = new BridleGuard({
      storage: adapter,
      signatureVerifier: dummyVerifier,
      config: { defaultBudget: { maxAmountPerWindow: '1.00', windowDurationSeconds: 3600 } },
    });

    const { ok, deny, other } = await fireConcurrent(guard, agent);
    expect(other).toEqual([]);
    expect(ok).toBe(1);
    expect(deny).toBe(N - 1);
    expect(await totalReserved(agent)).toBe(parseAmount('1.00')); // Truth-1: nunca overcommit
  });

  it('reservationId duplicado → ReservationConflictError (PK violation mapeada)', async () => {
    const agent = '0xcccc000000000000000000000000000000000003';
    await pool.query(
      `INSERT INTO bridle_test_agent_budgets
        (agent_address, currency, window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited)
       VALUES ($1, $2, $3, $4, NULL, false)`,
      [agent, CUR, 3600, parseAmount('100.00').toString()],
    );
    const guard = new BridleGuard({ storage: adapter, signatureVerifier: dummyVerifier, config: {} });

    await guard.checkAndReserve({ reservationId: 'dup', agentAddress: agent, amount: '1.00', currency: CUR });
    await expect(
      guard.checkAndReserve({ reservationId: 'dup', agentAddress: agent, amount: '1.00', currency: CUR }),
    ).rejects.toBeInstanceOf(ReservationConflictError);
  });

  it('upsertBudget escribe la política (write API del adapter)', async () => {
    const agent = '0xdddd000000000000000000000000000000000004';
    await adapter.upsertBudget({
      agentAddress: agent,
      currency: CUR,
      windowDurationSeconds: 3600,
      maxAmountPerWindow: '2.50',
      maxAmountPerTx: '1.00',
      unlimited: false,
    });
    const read = await adapter.getBudget(agent, CUR);
    expect(read).toMatchObject({ maxAmountPerWindow: '2.500000', maxAmountPerTx: '1.000000', unlimited: false });
    // upsert (segunda vez) reemplaza
    await adapter.upsertBudget({
      agentAddress: agent,
      currency: CUR,
      windowDurationSeconds: 7200,
      maxAmountPerWindow: '9.00',
      maxAmountPerTx: null,
      unlimited: true,
    });
    expect(await adapter.getBudget(agent, CUR)).toMatchObject({
      windowDurationSeconds: 7200,
      maxAmountPerWindow: '9.000000',
      maxAmountPerTx: null,
      unlimited: true,
    });
  });
});
