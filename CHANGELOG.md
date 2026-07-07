# Changelog

All notable changes to `@igarzatech/bridle` are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [0.2.2] — 2026-07-07

### Changed
- `engines` widened from `20.x` to **`>=20`** and the `pnpm` engine constraint dropped from
  the published package. Consumers on Node 22/24 no longer get an `EBADENGINE` warning — the
  package is pure JS and runs on any Node ≥20. No API changes.

## [0.2.1] — 2026-07-06

### Changed
- First release published through the automated release pipeline, **with npm provenance /
  build attestations**. Functionally identical to `0.2.0`; repository metadata
  (`repository`/`homepage`/`bugs`) added to the package. Use `^0.2.1` for provenance.

## [0.2.0] — 2026-07-02

### Added
- **Policy Engine** — declarative, JSON-serializable spend rules evaluated *inside* the
  concurrency-safe reservation path: recipient allowlists/denylists, per-category window and
  per-tx limits, and time-window rules (explicit timezone). Deterministic precedence,
  independent of rule order.
- **Auditable decisions** — every allow/deny is emitted to a pluggable `PolicyAuditSink` with
  a reason code. The default sink is a no-op (no side effects, no timers). A throwing sink
  can never break the guard flow (best-effort, isolated).
- `validatePolicySet` for validating rule sets at configuration time.
- x402 hook maps policy denials to HTTP `403` (distinct from budget `429`).

### Changed
- `signatureVerifier` is now **optional** on `BridleGuard`. Budget operations
  (`checkAndReserve`/`commit`/`release`/`expire`) work without it; `verifyAndConsumeNonce`
  without a verifier throws a typed `ConfigurationError`.

### Backward compatibility
- With no `PolicySet` configured, behavior is identical to `0.1.0`. `ReserveInput` was
  extended with optional fields only.

## [0.1.0] — 2026-06-11

### Added
- Initial release. Framework-agnostic `BridleGuard` core: `reserve` / `commit` / `release` /
  `expire`, rolling window, fail-safe by default, exact `bigint` arithmetic (6 decimals).
- `BridleStorage` interface with the non-negotiable `withAgentLock` serialization contract.
- **`PostgresStorageAdapter`** (`/postgres`) — `pg_advisory_xact_lock` per `(agent, currency)`;
  a concurrency test against **real Postgres** ships with the package and runs in CI.
- Identity / anti-DoS (`verifyAndConsumeNonce`) behind a `SignatureVerifier` interface, with a
  default secp256k1 (EIP-191) implementation.
- x402 hook (`/x402`) — framework-agnostic `withBudget(payFn)` + Express error handler.

[0.2.2]: https://github.com/IgarzaTech/bridle/releases/tag/v0.2.2
[0.2.1]: https://github.com/IgarzaTech/bridle/releases/tag/v0.2.1
[0.2.0]: https://github.com/IgarzaTech/bridle/releases/tag/v0.2.0
[0.1.0]: https://github.com/IgarzaTech/bridle/releases/tag/v0.1.0
