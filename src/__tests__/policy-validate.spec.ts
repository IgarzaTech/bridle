/**
 * Tests del validador `validatePolicySet` (feature 0006, AC-10) y del round-trip
 * JSON de los tipos (AC-1).
 */
import { validatePolicySet } from '../policy/validate';
import {
  POLICY_SCHEMA_VERSION,
  type PolicySet,
  type PolicyRule,
} from '../policy/types';

function set(rules: PolicyRule[]): PolicySet {
  return { schemaVersion: POLICY_SCHEMA_VERSION, rules };
}

describe('AC-1 — tipos JSON-serializables y versionados', () => {
  it('round-trip JSON.parse(JSON.stringify(p)) sin pérdida', () => {
    const p: PolicySet = set([
      { type: 'recipient', id: 'r1', allow: ['0xAbc', '0xDef'], deny: ['0xBad'] },
      {
        type: 'category',
        id: 'c1',
        category: 'cloud',
        maxAmountPerWindow: '50.00',
        windowDurationSeconds: 86_400,
        maxAmountPerTx: '10.00',
      },
      {
        type: 'timeWindow',
        id: 't1',
        timezone: 'America/New_York',
        startMinute: 540,
        endMinute: 1020,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
    ]);
    const roundTripped = JSON.parse(JSON.stringify(p)) as PolicySet;
    expect(roundTripped).toEqual(p);
    expect(roundTripped.schemaVersion).toBe(POLICY_SCHEMA_VERSION);
  });
});

describe('AC-10 — validatePolicySet', () => {
  it('set válido → ok', () => {
    const result = validatePolicySet(
      set([{ type: 'recipient', id: 'r1', allow: ['0xabc'] }]),
    );
    expect(result).toEqual({ ok: true });
  });

  it('schemaVersion desconocida → error', () => {
    const result = validatePolicySet({ schemaVersion: 999, rules: [] });
    expect(result.ok).toBe(false);
  });

  it('monto no parseable → error que identifica la regla', () => {
    const result = validatePolicySet(
      set([
        {
          type: 'category',
          id: 'c-bad',
          category: 'cloud',
          maxAmountPerWindow: 'not-a-number',
          windowDurationSeconds: 3600,
        },
      ]),
    );
    expect(result).toMatchObject({ ok: false, ruleId: 'c-bad' });
  });

  it('tipo de regla desconocido → error que identifica la regla', () => {
    const result = validatePolicySet(
      set([{ type: 'wormhole', id: 'w1' } as unknown as PolicyRule]),
    );
    expect(result).toMatchObject({ ok: false, ruleId: 'w1' });
  });

  it('TZ inválida → error que identifica la regla', () => {
    const result = validatePolicySet(
      set([
        {
          type: 'timeWindow',
          id: 't-bad',
          timezone: 'Mars/Olympus_Mons',
          startMinute: 0,
          endMinute: 100,
        },
      ]),
    );
    expect(result).toMatchObject({ ok: false, ruleId: 't-bad' });
  });

  it('allowlist vacía → error que identifica la regla', () => {
    const result = validatePolicySet(
      set([{ type: 'recipient', id: 'r-empty', allow: [] }]),
    );
    expect(result).toMatchObject({ ok: false, ruleId: 'r-empty' });
  });

  it('id de regla duplicado → error', () => {
    const result = validatePolicySet(
      set([
        { type: 'recipient', id: 'dup', allow: ['0xa'] },
        { type: 'recipient', id: 'dup', deny: ['0xb'] },
      ]),
    );
    expect(result).toMatchObject({ ok: false, ruleId: 'dup' });
  });

  it('regla sin id → error', () => {
    const result = validatePolicySet(
      set([{ type: 'recipient', allow: ['0xa'] } as unknown as PolicyRule]),
    );
    expect(result.ok).toBe(false);
  });
});
