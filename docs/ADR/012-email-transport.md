# ADR-012: Email through an HTTPS API (Resend), console in development

**Status:** Accepted

## Context
P02-T05 needs email (confirm an address, reset a password). The chosen host's free plan (ADR-011) blocks SMTP ports, and no dependency may be added without a regenerated lockfile.

## Decision
`src/services/email.js` with three transports: `console` (log, development default), `resend` (HTTPS POST to Resend with Node's `fetch`), `memory` (tests). Free-plan limits of Resend were read on 2026-10-28 and are in `docs/EMAIL.md` (3,000 a month, 100 a day, own verified domain needed to send to others).

## Consequences
- No new dependency. SMTP is not supported.
- Real delivery needs a domain the owner controls; without one the site runs with `EMAIL_VERIFICATION_REQUIRED=false`.
- Switching provider means writing another transport; callers do not change.
