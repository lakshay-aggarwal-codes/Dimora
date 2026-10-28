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
| [007](007-maps-provider.md) | Maps provider: keep Mapbox, two tokens | Accepted (limits to be confirmed by owner) | P06-T01 |
| [008](008-market-defaults.md) | Market defaults: India, INR, Asia/Kolkata | Accepted | P19-T02 |
| [009](009-simulated-payments.md) | Payments are simulated and labelled | Accepted | P16-T02 |
| [010](010-reviews-belong-to-stays.md) | Reviews belong to completed stays; older reviews are labelled | Accepted | P12-T02, P12-T05 |
| [011](011-hosting.md) | Hosting: Render free web service, Atlas Free, Cloudinary Free | Accepted (provisional until first deployment) | P19-T04 |
| [012](012-email-transport.md) | Email through an HTTPS API (Resend); console in development | Accepted | P02-T05 |
