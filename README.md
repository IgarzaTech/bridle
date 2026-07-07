**English** | [Español](./README.es.md)

# @igarzatech/bridle

[![npm version](https://img.shields.io/npm/v/@igarzatech/bridle.svg?logo=npm)](https://www.npmjs.com/package/@igarzatech/bridle)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blueviolet?logo=npm)](https://www.npmjs.com/package/@igarzatech/bridle#provenance)
[![CI](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml/badge.svg)](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?logo=node.js)](https://nodejs.org)
[![types included](https://img.shields.io/badge/types-included-blue.svg?logo=typescript)](./dist/index.d.ts)

**The budget that actually blocks.** Per-agent spend guardrail for agentic payments —
framework-agnostic, storage-pluggable, x402-ready.

Bridle sits in front of a payment attempt: it **reserves** the budget before paying,
**commits** on settlement, and **releases** if the payment fails or expires. Under real
concurrency it guarantees an agent never exceeds its limit — validated by a concurrency
test against **real Postgres** that runs in CI.

```bash
npm install @igarzatech/bridle
```

---

## Why Bridle?

Agents that spend money break in a specific way: they overspend under concurrency, and the
guardrail that was supposed to stop them *silently* lets the money through. Most "AI spend"
tools are **observability** — they tell you what an agent spent *after* it spent it, or cap
usage per API key without a per-task accounting model. That's a dashboard, not a brake.

Bridle is the brake. What makes it different — and what nobody else combines:

- **Pre-execution reservation, not post-hoc tracking.** Budget is *reserved before* the
  payment (`reserve` → `commit`/`release`), so a request is denied *before* the money moves,
  not reconciled after.
- **A proven concurrency guarantee.** The hard part isn't the limit — it's that N concurrent
  requests from the same agent don't each read the same remaining budget and all pass. Bridle
  serializes per `(agent, currency)` with a Postgres advisory lock, and ships a test that
  fires ≥20 concurrent reservations against **real Postgres** and asserts exactly one wins.
  This bug is invisible to unit tests with mocks; the guarantee travels with the adapter.
- **Auditable decisions.** Every allow/deny goes to a pluggable audit sink with a reason code
  — the evidence trail compliance and due diligence ask for.
- **Fail-closed by design.** No policy and no default → **deny**. Missing context a policy
  needs → **deny**. A budget guardrail that fails open is not a guardrail.
- **Cross-rail, non-custodial.** Bridle never moves funds and never holds keys — it only
  counts and decides. It sits *above* any wallet, rail, or `x402` facilitator you bring.

If you only need "tell me what my agents spent," you don't need Bridle. If you need
"guarantee this agent cannot exceed its budget, even under load, with an audit trail" —
that's exactly what this is.

- License: **Apache-2.0** · Node: **>=20** · Non-custodial · TypeScript-first (types included).

---

## Quickstart (2 minutes)

> **Want to see it run?** [`examples/`](./examples) has a 2-minute demo — a budget that lets
> one payment through and blocks the next — in `mock` mode (zero setup) or against real Tempo
> testnet.

```bash
pnpm add @igarzatech/bridle pg
```

```ts
import { BridleGuard } from '@igarzatech/bridle';
import { PostgresStorageAdapter } from '@igarzatech/bridle/postgres';
import { withBudget } from '@igarzatech/bridle/x402';
import { Pool } from 'pg';

// 1. Storage: you bring the Postgres Pool (Bridle does not create it).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter(pool, { tablePrefix: 'bridle_' });
await storage.migrate(); // creates agent_budgets / budget_ledger / used_nonces

// 2. Guard: fail-safe — with no policy and no default, it DENIES (never allows blindly).
//    The `signatureVerifier` is OPTIONAL: you only need it for identity/anti-DoS
//    (verifyAndConsumeNonce). For budget-only you pass no verifier.
const guard = new BridleGuard({
  storage,
  config: {
    // default budget for agents without their own row: $1.00 per day
    defaultBudget: { maxAmountPerWindow: '1.00', windowDurationSeconds: 86_400 },
  },
});

// 3. Wrap the payment call. The first dollar goes through…
const agentAddress = '0xabc...';
async function pay(reservationId: string): Promise<string> {
  return withBudget(
    guard,
    { reservationId, agentAddress, amount: '1.00', currency: 'USDC' },
    async () => {
      // your real payment goes here (x402 / MPP / Tempo / whatever). Bridle doesn't know it.
      return 'paid';
    },
  );
}

await pay('r1'); // ✅ reserves, pays, commits
await pay('r2'); // ❌ throws BudgetExceededError — the budget actually BLOCKS
```

That's it: the second payment is rejected with `BudgetExceededError` (HTTP 429 if you use
the Express adapter) because the agent already spent its dollar for the window.

---

## Concepts

### Storage and the concurrency contract (read this)

`BridleStorage` abstracts persistence. Its non-negotiable piece is **`withAgentLock`**:
it serializes reservations per `(agent, currency)`. **Without that serialization the
guardrail does NOT block** — two concurrent reservations would read the same total and
both pass (overcommit). The Postgres adapter implements it with `pg_advisory_xact_lock`,
which serializes even when the agent has no budget row.

If you implement your own Storage adapter, **it must satisfy the same concurrency
guarantee** — the repo's concurrency test (run in CI against real Postgres) shows what
that means. It is not optional: it is the central guarantee.

### Writing per-agent policies

Bridle **owns the schema** of `agent_budgets`, so it provides the write API — do not
write raw SQL against the internal table:

```ts
await storage.upsertBudget({
  agentAddress: '0xabc...',
  currency: 'USDC',
  windowDurationSeconds: 86_400,
  maxAmountPerWindow: '50.00',
  maxAmountPerTx: '5.00', // or null
  unlimited: false,       // explicit opt-in for "no limit"
});
```

With no policy of its own and no `defaultBudget`, the guard **denies** (fail-safe).

### Reservation lifecycle

`reserved → committed` (payment settled) **or** `reserved → released` (failed/expired). A
committed spend is never reverted. Each `reservationId` is unique: reusing it throws
`ReservationConflictError` (no silent overwrite).

> **Finality caveat — choose the TTL well.** If a reservation expires and is released
> (`released`), but the payment settles **later**, the `commit` re-records the spend
> (`released → committed`) — which is correct: the spend was real. But between the release
> and that late commit, another reservation may have taken that slot, so **the window can
> transiently exceed the limit**. To avoid it, configure the **reservation TTL larger than
> your rail's worst-case settlement finality** (so the reservation does not expire before
> the payment can settle).

### Expiration — YOU must call `expire()`

Bridle **starts no scheduler**. If nobody releases unredeemed reservations, they pile up
and block the legitimate agent. Call `guard.expire()` periodically from your cron/worker,
or use the opt-in helper:

```ts
const stop = guard.startExpirySweeper(60_000); // every 60s; opt-in, not implicit
// …
stop(); // when you shut the process down
```

### Identity / anti-DoS (optional)

The budget is tracked against a declared `agentAddress`. By itself, that means an attacker
could drain a victim's budget just by declaring the victim's address — so authenticate the
identity (verify a signature) before reserving.
This feature **requires** that you pass a `signatureVerifier` when building the guard
(otherwise `verifyAndConsumeNonce` throws `ConfigurationError`):

```ts
import { BridleGuard, Secp256k1SignatureVerifier } from '@igarzatech/bridle';

const guard = new BridleGuard({
  storage,
  signatureVerifier: new Secp256k1SignatureVerifier(), // explicit: enables identity
  config: { /* … */ },
});

await guard.verifyAndConsumeNonce({
  agentAddress,
  nonce,                 // unique per attempt
  nonceTimestamp,        // unix seconds
  signature,             // EIP-191 signature of `bridle-identity:<addr>:<nonce>:<ts>`
});
```

Verification order: **signature → freshness → anti-replay**. The default
`Secp256k1SignatureVerifier` validates standard EOA signatures (MetaMask/viem/ethers)
out-of-the-box. Another signing scheme? Implement the `SignatureVerifier` interface and
pass it instead.

### Express adapter (nice-to-have)

```ts
import { bridleExpressErrorHandler } from '@igarzatech/bridle/x402';
app.use(bridleExpressErrorHandler); // maps Bridle errors to HTTP (429/403/409/…)
```

---

## Policy Engine — declarative spend rules (0.2.0)

Beyond *how much* an agent may spend (budget), Bridle governs **what, to whom and when**:
a **declarative** `PolicySet` (JSON data, not code) evaluated at the **same enforcement
point** as the budget (inside `withAgentLock`), so a policy deny inherits the same
concurrency guarantee — it never inserts a reservation.

MVP rule types: **recipient allow/denylist**, **per-category limits** (per-window and
per-tx amount, independent per category) and **time windows** with an explicit timezone
(IANA/UTC).

**Fixed, deterministic precedence** (independent of array order):
1. recipient `deny` always wins.
2. recipient allowlist: unlisted → deny.
3. time windows & per-category limits.
4. global budget (0004) last.

**Fail-safe:** a malformed rule, an unknown type, or a policy that references a field
(`recipient`/`category`) absent from the spend context → **deny + typed error**, never a
silent allow. A typo in a policy never opens spending.

> ⚠ If you configure a recipient allowlist (or category rules) but do NOT pass
> `context.recipient` / `context.category` on the reservation, Bridle **denies** — it does
> not ignore the rule. Intentional: it prevents a false sense of security.

### Copy-paste example (allowlist + per-category limit + time window)

```ts
import { BridleGuard, type PolicySet, POLICY_SCHEMA_VERSION } from '@igarzatech/bridle';
import { withBudget } from '@igarzatech/bridle/x402';

// A PolicySet is plain JSON: serializable, versioned, auditable.
const policySet: PolicySet = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  rules: [
    // 1. Only these recipients (unlisted → deny). Denylist always wins.
    { type: 'recipient', id: 'vendors', allow: ['0xvendor-a', '0xvendor-b'] },
    // 2. A $50/day cap for "cloud" (independent of the global budget).
    {
      type: 'category',
      id: 'cloud-cap',
      category: 'cloud',
      maxAmountPerWindow: '50.00',
      windowDurationSeconds: 86_400,
      maxAmountPerTx: '10.00',
    },
    // 3. Business hours only, EXPLICIT timezone (never the server's).
    {
      type: 'timeWindow',
      id: 'business-hours',
      timezone: 'America/New_York',
      startMinute: 9 * 60,   // 09:00
      endMinute: 17 * 60,    // 17:00
      daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
    },
  ],
};

// Set source: static config (defaultPolicySet) or via Storage.getPolicySet.
const guard = new BridleGuard({
  storage,
  config: {
    defaultBudget: { maxAmountPerWindow: '100.00', windowDurationSeconds: 86_400 },
    defaultPolicySet: policySet,
    // Optional: audit sink (receives EVERY decision, allow and deny).
    auditSink: { record: (e) => console.log(e.decision.reasonCode, e.decision.ruleId) },
  },
});

// The spend context is propagated by withBudget into policy evaluation.
await withBudget(
  guard,
  {
    reservationId: 'r1',
    agentAddress: '0xabc...',
    amount: '5.00',
    currency: 'USDC',
    context: { recipient: '0xvendor-a', category: 'cloud' },
  },
  async () => 'paid', // your real payment
);
// A policy deny throws PolicyDeniedError (HTTP 403 via mapBridleErrorToHttp),
// distinguishable from the budget 429. An invalid set → PolicyInvalidError (403).
```

Validate a `PolicySet` at config time with `validatePolicySet(set)` (returns
`{ ok: true }` or an error identifying the offending rule — it does not throw).

---

## Decimals

The MVP fixes **6 decimals** (USD stablecoins: pathUSD, USDC). Amounts cross the API as a
**string** (`"100.00"`) and are computed internally as exact `bigint` — no floats.
Per-currency decimals is post-MVP.

---

## Status

`0.2.0` — Budget guardrail + Policy Engine. Public API versioned with semver.
