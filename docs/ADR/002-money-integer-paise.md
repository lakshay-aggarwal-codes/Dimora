# ADR-002: Money is stored as integer paise

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

Listings currently store `price` as a float `Number` in rupees. Pricing, fees, taxes, refunds and totals will be computed, summed and compared; floating-point arithmetic produces rounding errors and mismatched totals.

## Decision

Every money value is an integer in minor units (paise for INR), stored as `amountMinor` (or `<name>Minor`) next to a currency code (`INR`). Only `services/pricing.js` computes amounts; rounding rules are defined there in one place. Conversion to a display string (for example with `en-IN` formatting) happens only in views and helpers. The browser never submits an authoritative amount; it may send `expectedTotalMinor` only so the server can detect a stale quote.

## Consequences

- The existing `price` field needs a migration to integer paise (done in the listing schema task, P04-T01).
- Forms must convert user-entered rupees to paise on the server, with validation.
- All totals are exactly reproducible in tests.
- Slightly more conversion code at the edges; accepted.

## Alternative rejected

Storing decimals as `Number` rupees (current), or using `Decimal128`. Rejected: floats are inexact; `Decimal128` adds driver/serialisation friction for no benefit when whole paise suffice.
