# ADR-004: Booking integrity uses a unique-index night ledger

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

Two guests must never hold the same night of the same listing, even when requests arrive at the same time. Application-level "check then insert" logic is racy. Multi-document transactions need a replica set: Atlas has one, a local standalone `mongod` does not.

## Decision

Create a `StayNight` document for every reserved or blocked night: `{ listing, date, source: { kind: "reservation" | "block", id }, holdExpiresAt? }`, with a **unique index on `(listing, date)`**.

- To book, the service computes the nights and calls `insertMany(nights, { ordered: true })`. A duplicate-key error (code 11000) means another request holds a night: respond **409 Conflict** and delete any rows this attempt inserted.
- The `Reservation` is created only after all nights are held; if that insert fails, the nights are released. A sweeper removes ledger rows whose reservation is missing or terminal.
- Pending requests keep their nights with `holdExpiresAt`. A collision with an **expired** hold deletes the stale row with a conditional delete and retries once.
- Status changes use compare-and-set (`findOneAndUpdate({ _id, status: expectedFrom }, ...)`); zero matches returns 409.
- Transactions are optional hardening, never required.
- Frontend availability is a convenience only and is never trusted.
- The approach is proven by a concurrency spike and stress suite before dependent tasks (P07-T02, P07-T08); measured results will be added to this ADR.

## Consequences

- The database, not application code, enforces "no double booking".
- Works on a standalone local `mongod` and on Atlas.
- Extra collection and a sweeper to keep consistent; every release path must free nights.
- Long stays create many rows; acceptable at this scale.
- If the spike shows the design fails, this ADR is revised before building on it.

## Alternative rejected

Application-level availability checks, or relying on multi-document transactions alone. Checks are racy; transactions would force a replica set locally and still need a unique constraint for correctness.

## Spike implementation and results (P07-T02)

Implemented in `src/models/stayNight.js` and `src/services/ledger.js` (`reserveNights`, `releaseNights`, `availableRanges`).

Details the design needed once it was built:

- **Ascending insert order.** Nights are sorted before `insertMany(..., { ordered: true })`. With one global order, two overlapping requests cannot each hold part of the other's range and both fail: whoever takes the first contested night wins the rest.
- **Compensation deletes by `_id`.** Each attempt generates its `_id`s up front and, on any error, deletes exactly those rows. Deleting by `source.id` would destroy the rows of an earlier successful call for the same reservation (a double submit).
- **Transient conflicts.** A losing request can collide with rows another attempt is about to roll back, so a 409 may be spurious for a moment; callers may retry. Correctness (no night with two owners) is never affected.
- **Stale-hold takeover** is one retry after `deleteMany({ listing, date: { $in: nights }, holdExpiresAt: { $lt: now } })`. The condition means a row that was confirmed (hold removed) is never deleted. A request retries only if that delete removed something.
- `ConflictError` has code `nights_unavailable` and `conflictingDates` for the message.

Measured results (to be filled in from a real MongoDB run; the sandbox that wrote this code had no `mongod`):

| Check | Command | Result |
|---|---|---|
| 50 parallel requests, same nights: exactly one wins | `npm test -- tests/integration/ledger.db.test.js` | _not yet recorded_ |
| 20 consecutive runs of the suite | `1..20 \| ForEach-Object { npm test -- tests/integration/ledger.db.test.js }` | _not yet recorded_ |
| Time for 50 contenders on 3 nights (local mongod) | same | _not yet recorded_ |

If any run shows two owners of a night or a request that holds only part of its nights, this ADR is revised before P07-T05 builds on it.

## Sweeper (P07-T07)

`src/services/sweeper.js` is the "sweeper" this ADR promised. One pass, every minute (`npm run sweep` runs it by hand):

1. **Expire** `pending` reservations whose `holdExpiresAt` is in the past, through `reservations.transition(..., "expired", { actor: "system" })`, so the nights are released by the same code path as every other release.
2. **Complete** `confirmed` reservations whose check-out date has passed in the listing's own time zone (`listingSnapshot.timezone`). Their past ledger rows are kept ("past rows kept", above).
3. **Delete orphan ledger rows**: rows whose reservation is missing or has released its nights (declined, expired, cancelled), and `block` rows with no `AvailabilityBlock` record. **Only rows older than 10 minutes are judged**, because booking writes the ledger rows first and the owner a moment later; a row without an owner is normal for a few milliseconds. The scan is a rolling window (1000 rows per pass, resuming after the last `_id`), so one pass never reads the whole collection.
4. **Delete drafts** untouched for 90 days (`src/services/drafts.js`), at most once an hour per instance.

Several instances are safe without a lock: steps 1 and 2 are compare-and-set transitions (the loser gets a 409 and counts it as "skipped"), step 3 deletes by row `_id` and a repeat deletes nothing, step 4 re-checks each draft in its own delete.

## Changing a booking's dates (P09-T04)

The unique `(listing, date)` index refuses a night the booking already holds, so a date change cannot "hold the new stay, then release the old one" literally. It works on the difference instead: (1) hold the nights that are new (all or nothing), (2) for a pending request move the hold of the kept nights, (3) compare-and-set the reservation (status and old dates must be unchanged), (4) trim the ledger to exactly the new nights. A conflict in step 1 changes nothing; losing step 3 releases exactly the nights step 1 added (`releaseNightsOn`). A failed step 4 leaves old nights blocked (the safe side) and `trimNights` is idempotent, so it can be repeated. The sweeper cannot see such leftover rows (it judges rows by the state of their reservation only).
