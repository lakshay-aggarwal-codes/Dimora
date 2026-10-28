# ADR-010: Reviews belong to completed stays; older reviews are labelled

- Status: Accepted
- Date: 2026-10-23
- Source: P12-T01; `MASTER_ROADMAP.md`

## Context

Until now anyone with an account could review any listing, any number of times, and nothing tied a review to a real stay. Dimora now has bookings (reservations with a state machine and a night ledger), so a review can mean "this guest stayed here". The repository also holds reviews written under the old rules.

## Decision

1. **A new review needs a reservation.** The review stores `reservation`, `listing`, `author`, `rating`, `comment` and a `listingSnapshot` (title, city). It is accepted only when the reservation is `completed`, its guest is the author, the author is not the host, the account is active, and the stay ended no more than `REVIEW_WINDOW_DAYS` ago (default 30, 1 to 365; counted in the listing's own time zone from the check-out date). Each rule has its own message and code (`stay_not_completed`, `own_listing`, `review_window_closed`, `already_reviewed`, ...).
2. **One review per stay** is enforced by a partial unique index on `reservation` (`reservation_1_unique`, only where `reservation` is an ObjectId). The service also looks first, for a clear message, but the index is what decides when two requests race.
3. **A review outlives its listing.** `listing` and `listingSnapshot` stay on the review. Hard-deleting a listing removes only reviews that have no reservation. A stay at a listing that was taken down can still be reviewed during the window.
4. **Older reviews are kept and labelled.** Migration 008 sets `legacy: true` on every review without a reservation, fills `listing` from the listing that holds it, removes the misspelt `crestedAt` and gives a review without `createdAt` the time its `_id` was created. On the listing page a legacy review shows the note **"Posted before bookings existed on Dimora"**. It still counts and still shows; it is not hidden and not presented as a verified stay.
5. The listing page offers the review form only to a guest with a completed, unreviewed stay in the window. Prompts on the trips page and the star input rework are P12-T02.

## Consequences

- A review is a statement about a real, completed stay, which is the only honest basis for a "reviewed by guests who stayed" label (P12-T05).
- Old reviews cannot be proven to come from stays, so they are labelled instead of deleted or silently mixed in. Deleting a review (author or admin) frees its stay to be reviewed again within the window.
- Rating aggregates still read `listing.reviews` (a new review is pushed there); P12-T02 replaces that with an atomic aggregate.
- The window is configuration, not code: changing `REVIEW_WINDOW_DAYS` applies to stays not yet reviewed.

## Alternatives rejected

- **Hide or delete legacy reviews.** Loses content the project already has and leaves new listings empty; a label is enough to be honest.
- **No label.** Presents unverified reviews exactly like verified ones.
- **Check the one-review rule only in code.** Two simultaneous requests could both pass the check; the unique index closes that.

## Update (P12-T03): editing and host replies

- **The author may edit rating and comment for `REVIEW_EDIT_DAYS` after posting** (default 7, 1 to 90), measured from `createdAt` (a review without one is dated by its id). Only the author: an admin hides a review, never rewrites it. A hidden review cannot be edited. The review keeps `editedAt` and the page shows "Edited"; the previous text is not kept.
- **A rating change moves the totals by the difference** in one atomic update (`ratings.changeRating`), using the rating the compare-and-set on the review returned as "before", so two edits at once still add up.
- **The listing's host may write one public reply per review** (up to 1000 characters; writing again replaces it, `editedAt` is recorded; the host can remove it). The reply is decided on the listing (`review:reply`: its owner only, not an admin) and is shown as "Response from the host". A hidden review takes its reply with it out of sight.
