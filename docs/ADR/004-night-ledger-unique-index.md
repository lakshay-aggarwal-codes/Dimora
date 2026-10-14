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
