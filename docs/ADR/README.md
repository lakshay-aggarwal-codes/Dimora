# Architecture Decision Records

Decisions that shape the whole codebase. Each record states context, decision, consequences, and the alternative that was rejected. Status values: **Accepted**, **Provisional** (to be confirmed by the named task), **Superseded**.

| ADR | Title | Status | Revisited by |
|---|---|---|---|
| [001](001-monolith-ejs.md) | Keep the monolith and server-rendered EJS | Accepted | — |
| [002](002-money-integer-paise.md) | Money is stored as integer paise | Accepted | — |
| [003](003-calendar-dates-utc-midnight.md) | Stay dates are calendar dates stored as UTC midnight | Accepted | — |
| [004](004-night-ledger-unique-index.md) | Booking integrity uses a unique-index night ledger | Accepted | P07-T02 (measured results) |
| [005](005-test-stack.md) | Test stack: Jest, supertest, mongodb-memory-server | Accepted | P01-T08 |
| [006](006-csrf-approach.md) | CSRF protection approach | Provisional | P01-T10 (verify package) |
| [007](007-maps-provider.md) | Maps provider: keep Mapbox (provisional) | Provisional | P06-T01 |
| [008](008-market-defaults.md) | Market defaults: India, INR, Asia/Kolkata | Accepted | P19-T02 |
| [009](009-simulated-payments.md) | Payments are simulated and labelled | Accepted | P16-T02 |
