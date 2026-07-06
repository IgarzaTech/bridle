/**
 * Test de concurrencia REAL contra Postgres para el LÍMITE POR CATEGORÍA del Policy
 * Engine (feature 0006, AC-5). Réplica del patrón de `concurrency.spec.ts`:
 *  - gated por DATABASE_HOST (skip local; FALLA en CI si falta),
 *  - aislamiento con prefijo `bridle_test_`,
 *  - N reservas concurrentes de la MISMA categoría con cupo para una → exactamente 1 OK.
 *
 * La evaluación de la política corre dentro de `withAgentLock` (pg_advisory_xact_lock),
 * así que el límite por categoría hereda la garantía de no-overcommit del presupuesto.
 */
import { Pool } from 'pg';
import { BridleGuard } from '../../guard';
import { PostgresStorageAdapter } from '../index';
import { parseAmount } from '../../amount';
import { POLICY_SCHEMA_VERSION, type PolicySet } from '../../policy/types';

const HAS_DB = !!process.env.DATABASE_HOST;
const IN_CI = process.env.TF_BUILD === 'True';

const CUR = 'USDC';
const AMOUNT = '1.00';
const N = 20;

// GATE: CI sin DATABASE_HOST → FALLA (no skip). Skippear solo es válido en local.
if (IN_CI && !HAS_DB) {
  describe('PostgresStorageAdapter — límite por categoría concurrente (AC-5) — GATE CI', () => {
    it('DEBE ejecutarse en CI: DATABASE_HOST ausente → la garantía NO se validó', () => {
      throw new Error(
        'CI sin DATABASE_HOST: el test de concurrencia del límite por categoría ' +
          '(feature 0006, AC-5) no se ejecutó. Configura DATABASE_HOST/PORT/USER/PASSWORD/NAME ' +
          'en el pipeline. Skippear solo es válido en local.',
      );
    });
  });
}

/** PolicySet con un cupo de 1.00 por ventana para la categoría "cloud". */
const cloudCappedPolicy: PolicySet = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  rules: [
    {
      type: 'category',
      id: 'cap-cloud',
      category: 'cloud',
      maxAmountPerWindow: '1.00',
      windowDurationSeconds: 3600,
    },
  ],
};

(HAS_DB ? describe : describe.skip)(
  'PostgresStorageAdapter — límite por categoría concurrente (AC-5)',
  () => {
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

    async function fireConcurrentCategory(
      guard: BridleGuard,
      agentAddress: string,
      category: string,
    ): Promise<{ ok: number; deny: number; other: unknown[] }> {
      const calls = Array.from({ length: N }, (_v, i) =>
        guard.checkAndReserve({
          reservationId: `${agentAddress}-${category}-${i}`,
          agentAddress,
          amount: AMOUNT,
          currency: CUR,
          context: { category },
        }),
      );
      const results = await Promise.allSettled(calls);
      let ok = 0;
      let deny = 0;
      const other: unknown[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') ok += 1;
        else if ((r.reason as { reasonCode?: string })?.reasonCode === 'category_limit_exceeded') {
          deny += 1;
        } else other.push(r.reason);
      }
      return { ok, deny, other };
    }

    it('N reservas concurrentes de la misma categoría con cupo 1 → exactamente 1 OK', async () => {
      const agent = '0xcat0000000000000000000000000000000000001';
      // Presupuesto global holgado: el límite que bloquea es el de la CATEGORÍA.
      await pool.query(
        `INSERT INTO bridle_test_agent_budgets
          (agent_address, currency, window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited)
         VALUES ($1, $2, $3, $4, NULL, false)`,
        [agent, CUR, 3600, parseAmount('999.00').toString()],
      );
      const guard = new BridleGuard({
        storage: adapter,
        config: { defaultPolicySet: cloudCappedPolicy },
      });

      const { ok, deny, other } = await fireConcurrentCategory(guard, agent, 'cloud');
      expect(other).toEqual([]);
      expect(ok).toBe(1);
      expect(deny).toBe(N - 1);
      // El acumulado por categoría nunca supera el cupo (bigint exacto).
      const totalCat = await adapter.sumActiveInWindowByCategory(agent, CUR, 'cloud', new Date(0));
      expect(totalCat).toBe(parseAmount('1.00'));
    });

    it('dos categorías con cupo propio: cada una admite exactamente 1 (independencia)', async () => {
      const agent = '0xcat0000000000000000000000000000000000002';
      await pool.query(
        `INSERT INTO bridle_test_agent_budgets
          (agent_address, currency, window_duration_seconds, max_amount_per_window, max_amount_per_tx, unlimited)
         VALUES ($1, $2, $3, $4, NULL, false)`,
        [agent, CUR, 3600, parseAmount('999.00').toString()],
      );
      const twoCaps: PolicySet = {
        schemaVersion: POLICY_SCHEMA_VERSION,
        rules: [
          { type: 'category', id: 'cap-cloud', category: 'cloud', maxAmountPerWindow: '1.00', windowDurationSeconds: 3600 },
          { type: 'category', id: 'cap-data', category: 'data', maxAmountPerWindow: '1.00', windowDurationSeconds: 3600 },
        ],
      };
      const guard = new BridleGuard({ storage: adapter, config: { defaultPolicySet: twoCaps } });

      const cloud = await fireConcurrentCategory(guard, agent, 'cloud');
      const data = await fireConcurrentCategory(guard, agent, 'data');
      expect(cloud.other).toEqual([]);
      expect(data.other).toEqual([]);
      expect(cloud.ok).toBe(1);
      expect(data.ok).toBe(1);
      expect(await adapter.sumActiveInWindowByCategory(agent, CUR, 'cloud', new Date(0))).toBe(
        parseAmount('1.00'),
      );
      expect(await adapter.sumActiveInWindowByCategory(agent, CUR, 'data', new Date(0))).toBe(
        parseAmount('1.00'),
      );
    });
  },
);
