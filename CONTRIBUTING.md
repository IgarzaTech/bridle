# Contributing to Bridle

Thanks for your interest. Bridle is small, focused, and security-sensitive — contributions
are welcome, and a bit of coordination up front saves everyone time.

## Start with an issue

Before writing code, **open an issue** (bug or proposal) so we can agree on the approach. For
anything touching the concurrency guarantee, the fail-safe behavior, or the money arithmetic,
this is not optional — those are the parts where a subtle change can silently break the core
promise ("an agent cannot exceed its budget").

## Local development

```bash
git clone https://github.com/IgarzaTech/bridle.git
cd bridle
pnpm install
pnpm build
pnpm lint
pnpm test          # unit tests run without a database
```

The **concurrency test** and the Postgres-backed tests need a real database. They are gated by
`DATABASE_HOST` (skipped locally, **required in CI** — a green pipeline means the guarantee was
actually validated). To run them locally:

```bash
docker run -d --name bridle-pg -e POSTGRES_USER=bridle -e POSTGRES_PASSWORD=bridle \
  -e POSTGRES_DB=bridle_test -p 5432:5432 postgres:16
DATABASE_HOST=localhost DATABASE_PORT=5432 DATABASE_USER=bridle \
  DATABASE_PASSWORD=bridle DATABASE_NAME=bridle_test pnpm test
```

## Bar for a change to be accepted

- **Every behavioral change ships with a test.** For anything on the spend path, that includes
  the concurrency test where relevant — a green unit suite is not sufficient evidence for money
  code (this is a lesson we paid for).
- **Fail closed.** No policy / missing context / unknown rule → deny, never allow.
- **Exact arithmetic.** Amounts are compared as scaled `bigint`, never `number`/float.
- TypeScript `strict`; no `any` without a `// why:` justification. Lint and build must pass.
- Public API changes are documented (TSDoc + README) and versioned with SemVer.

## How releases work (why your PR may be integrated rather than merged)

Releases are cut by an automated pipeline and this repository is the published home of the
package. Accepted changes are integrated by a maintainer and shipped with npm provenance. If
your PR is accepted, don't be surprised if it lands as a squashed/re-authored commit — the code
and the credit are preserved.

## License

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](./LICENSE) license.
