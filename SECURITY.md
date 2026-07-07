# Security Policy

Bridle is security-sensitive by nature: it is the guardrail that decides whether an
autonomous agent is allowed to spend money. We take reports seriously.

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.2.x` | ✅ |
| `< 0.2` | ❌ (please upgrade) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting: go to the
[**Security** tab](https://github.com/IgarzaTech/bridle/security) → **Report a vulnerability**.
This opens a private channel with the maintainers.

Please include: affected version, a description, and a reproduction (or a concurrency/edge-case
scenario). We aim to acknowledge within a few business days.

## Scope — what is and isn't a Bridle vulnerability

The core security guarantee is: **an agent cannot exceed its budget, even under concurrency,
and the guardrail fails closed.** Reports that undermine this are in scope, e.g.:

- A path where `checkAndReserve` allows overcommit under concurrency.
- A path where a missing/invalid policy or missing context results in an **allow** (fail-open)
  instead of a **deny**.
- Signature/nonce verification bypass in `verifyAndConsumeNonce`.

Out of scope: issues in your own `BridleStorage` implementation that violate the documented
`withAgentLock` contract (the guarantee depends on implementing it correctly — see the README),
and anything in the payment rail, wallet, or KYC/AML layer, which Bridle does not provide.
