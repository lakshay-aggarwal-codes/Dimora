# ADR-003: Stay dates are calendar dates stored as UTC midnight

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

Bookings are about nights, not instants. Parsing user strings with `new Date(userString)` depends on server time zone and input format, and causes off-by-one-day errors. Availability, pricing and cancellation rules all need an unambiguous definition of a night and of today.

## Decision

- A stay date is a calendar date, stored as a `Date` at 00:00:00.000Z, and parsed only from a strict `YYYY-MM-DD` string. `new Date(userString)` is never used for stay dates.
- Check-in is an occupied night; the check-out date is **not** an occupied night.
- "Today" for any rule (past-date checks, hold expiry, completion) is computed in the listing's `timezone` field, default `Asia/Kolkata`.
- Shared helpers (date parsing, night enumeration, today-in-timezone, policy dates) live in one utility module with unit tests (task P07-T01).
- Instants (timestamps such as `createdAt`, `holdExpiresAt`) remain ordinary UTC `Date` values.

## Consequences

- Every date boundary rule has one tested implementation.
- Views must format calendar dates as dates (not shifted by the viewer's time zone).
- Listings gain a `timezone` field (default `Asia/Kolkata`).
- Time-zone handling beyond a single zone per listing is out of scope.

## Alternative rejected

Storing dates as `YYYY-MM-DD` strings, or as local-time instants. Strings are easy to read but awkward for range queries and the unique night ledger; local-time instants reintroduce the time-zone ambiguity this ADR removes.
