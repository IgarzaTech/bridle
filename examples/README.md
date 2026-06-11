# Bridle demo — the budget that actually blocks

Runnable demo of [`@igarzatech/bridle`](../README.md). An agent with a tight budget
attempts **two payments**: the first goes through, the second is **blocked** because it
exceeds the budget — and the payment **never executes**. That contrast is the point.

> This is a reference artifact: it is **not published to npm** (it's not in the package's
> `files`). It imports Bridle through its public API, exactly as an external dev would.

## Run (mock mode — zero setup)

```bash
pnpm install            # from the repo root
pnpm --filter @igarzatech/bridle build   # builds the package the demo imports
pnpm --filter @igarzatech/bridle-example demo
```

`BRIDLE_DEMO_MODE=mock` (default): the payment is simulated (an `await` + a fake txHash).
Runs instantly, no network and no keys.

## Run (tempo mode — real testnet)

Sends a real pathUSD `transferWithMemo` on Tempo testnet (Moderato, chainId 42431). You
need an account funded with test pathUSD.

1. **Fund a wallet** (Tempo faucet, via `cast`):
   ```bash
   # generate a test signer
   cast wallet new
   # fund it with testnet pathUSD
   cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
   ```
   ```bash
   # No Foundry? Same call with curl:
   curl -s -X POST https://rpc.moderato.tempo.xyz -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tempo_fundAddress","params":["<YOUR_ADDRESS>"],"id":1}'
   ```
2. **Export the environment** and run:
   ```bash
   export BRIDLE_DEMO_MODE=tempo
   export TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz
   export TEMPO_TEST_PRIVATE_KEY=0x...   # the funded signer's key
   export TEMPO_TEST_RECIPIENT=0x...     # who receives the test payment
   pnpm --filter @igarzatech/bridle-example demo
   ```

Payment #1 prints the **real txHash** + a link to the explorer
(`https://explore.testnet.tempo.xyz/tx/<txHash>`). Payment #2 is blocked **without**
touching the chain (Bridle denies before paying).

> Identity / anti-DoS (signature + nonce) is NOT part of this demo, to keep the focus on
> budget blocking. It is optional and documented in the [package README](../README.md).

---

## Recording script (2 min) — internal note

**0:00 — Framing (15s).** "This is Bridle: a per-agent budget guardrail. The promise is
simple — when an agent runs out of budget, the payment **does not happen**. Not 'we log it
and notify': it does not happen. Let's see it live."

**0:15 — Setup (20s).** Show the code: budget `1.00`, two payments of `1.00`. "Budget for
exactly one payment. I wrap my payment call with `withBudget` — that's the whole
integration."

**0:35 — Run the demo (40s).** `pnpm --filter @igarzatech/bridle-example demo` (tempo mode).
- Payment #1 → **OK**: point at the txHash and open the explorer link. "Real payment,
  on-chain, confirmed. Bridle reserved, let it pay, and recorded the spend."
- Payment #2 → **🛑 BLOCKED**. "Second payment: exceeds the budget. Bridle throws
  `BudgetExceededError` **before** touching the chain. Check the explorer — there's no
  second transaction. The money never moved."

**1:15 — The why (30s).** "This demo runs with the **in-memory** storage (zero setup, so
you see it in seconds). The concurrency guarantee — if 20 payments arrive at once, exactly
one passes, never two — comes from the **Postgres adapter** with an advisory lock, and is
validated by the **concurrency test against real Postgres** that ships in the package.
Don't trust this video for that: run that test."

**1:45 — Close (15s).** "Framework-agnostic, storage-pluggable, Apache-2.0.
`pnpm add @igarzatech/bridle`. The guardrail that really blocks."
