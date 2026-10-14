# ADR-005: Test stack: Jest, supertest, mongodb-memory-server

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

The repository has no tests. Booking, authorization and money rules need a regression net that runs on a Windows laptop and in CI without a shared database.

## Decision

Use Jest as the runner, supertest for HTTP-level tests against the exported Express app, and `mongodb-memory-server` for an isolated in-memory MongoDB. Unit tests cover pure helpers (dates, money, state machine); integration tests cover routes, authorization and the night ledger. Cloudinary and Mapbox are mocked in tests. Scripts use `cross-env` where environment variables are needed so they work in PowerShell.

## Consequences

- The first run of `mongodb-memory-server` downloads a `mongod` binary (requires network access once). Some sandboxes cannot download it, so those tests are written there but may only execute on the owner's machine; reports must say so and never claim they passed.
- Concurrency tests run against a real MongoDB engine, so unique-index behaviour (ADR-004) is genuinely exercised.
- Requires splitting `app.js` into an importable app and a `server.js` (task P01-T03).
- Test suites are slower than pure unit tests; acceptable.

## Alternative rejected

Stubbing Mongoose in unit tests only, or a shared Atlas test database. Stubs cannot prove index behaviour; a shared database makes tests slow, flaky and dependent on credentials.
