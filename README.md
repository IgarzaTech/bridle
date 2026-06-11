**English** | [Español](./README.es.md)

[![CI](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml/badge.svg)](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml)

# @igarzatech/bridle

**The budget that actually blocks.** Per-agent spend guardrail for agentic payments —
framework-agnostic, storage-pluggable, x402-ready.

Bridle sits in front of a payment attempt: it **reserves** the budget before paying,
**commits** on settlement, and **releases** if the payment fails or expires. Under real
concurrency it guarantees an agent never exceeds its limit (validated by a concurrency
test against Postgres that ships with the package).

- License: **Apache-2.0**
- Node: **20.x**
- Non-custodial, never moves funds: Bridle only counts and decides.

---

## Quickstart (2 minutes)

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

If you implement your own Storage adapter, **it must pass the concurrency test** that
ships with the package. It is not optional: it is the central guarantee.

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

The budget is tracked against a declared `agentAddress`. So an attacker cannot drain a
victim's budget by declaring their address, authenticate the identity before reserving.
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

## Decimals

The MVP fixes **6 decimals** (USD stablecoins: pathUSD, USDC). Amounts cross the API as a
**string** (`"100.00"`) and are computed internally as exact `bigint` — no floats.
Per-currency decimals is post-MVP.

---

## Status

`0.1.0` — MVP. Public API versioned with semver.
