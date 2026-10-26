# Query and index review (P18-T02)

Every hot query of the app, what index answers it, and what changed. The queries are written down once as data in `src/services/queryPlans.js`; the same list is used by a unit test (it fails when a query has no usable index), by `npm run explain` (MongoDB's own `explain("executionStats")` on your database) and by `tests/integration/queryPlans.db.test.js`.

## What was measured, and what was not

This review was done **without a database**: the sandbox that prepared it has no MongoDB, so there are **no timings here**. The "before" and "after" below come from comparing each query's filter and sort with the declared indexes (equality fields first, then the sort keys in order), which is how MongoDB decides whether it can read an index in order. `tests/unit/queryPlans.test.js` checks that reasoning; **MongoDB's explain is the authority**, and checking the reasoning against it is your first step:

```powershell
npm run migrate:dry        # shows: toAdd 8, toDrop 4
npm run migrate            # builds the new indexes, then drops the 4 unused ones
npm run explain            # every hot query: index used, sort in memory?, keys / documents read
npm run explain -- --markdown   # the same as a table, to paste into "Measured" below
```

`npm run explain` exits with code 1 if a query scans the collection (except the one that says why), sorts in memory where it promises not to, or reads documents where the answer should come from the index alone. Run it on a database with realistic data (the seed from P19-T02, or a copy of production): on a nearly empty one MongoDB picks the same indexes but the numbers say nothing.

## Findings

| # | Query | Before | After |
|---|---|---|---|
| 1 | **Search with dates** (`ledger.unavailableListingIds`, the "available ±3 days" variant, P15-T04): "which listings have a taken night between these dates" has no listing in it | The only night indexes start with `listing` or `source.id` or `holdExpiresAt` (sparse): **the whole night ledger was read on every search with dates**, and it only ever grows | New index `date_1_listing_1_holdExpiresAt_1`; the query asks only for those fields and no `_id`, so it is answered **from the index alone** (no documents read) |
| 2 | **Search orders** (relevance/rating, newest, price both ways) with no destination | Index on `status` only, then **all published listings sorted in memory** for every page | Four indexes, one per order, each starting with `status` and ending with `_id` (the tie-break the sort uses): the first page reads only as many entries as it shows. Price descending reads the price index backwards |
| 3 | **Home page**, **search map with no box** (`sort _id desc, limit`) | Same: all published listings sorted in memory | `status_1__id_-1` |
| 4 | **Host inbox**, pending and confirmed lists | `(host, status)` index, then a sort in memory | `(host, status, holdExpiresAt, _id)` and `(host, status, checkIn, _id)`: already in order. They also answer every query on `(host, status)`, so the plain index is dropped |
| 5 | **Audit log page**, newest first | Index `createdAt` only, but the page sorts on `createdAt` **and `_id`**: the **whole log was sorted** on every page, and the log grows with every admin action | `(createdAt desc, _id desc)`; the old index is a prefix of it and is dropped |
| 6 | **Report a review** (P12-T04): "which listing holds this review" | `Listing.findOne({ reviews: id })`: no index on `reviews` (**collection scan of listings**) | The review knows its listing (`review.listing`, since reviews v2): read by id. Only an old review without one falls back to the scan |
| 7 | Redundant indexes | `status_1_address.city_1` (no query filters by `address.city`; searches use `cityKey`), `pricing.nightlyMinor_1` (every price query also filters on `status`), `host_1_status_1`, audit `createdAt_-1` each cost a write on every insert and update | Dropped by migration 010 |

Everything else was reviewed and is fine: the night calendar and quotes (`listing_1_date_1`), release by reservation (`source.id_1`), idempotency (`guest_1_idempotencyKey_1`), reviews by listing/author/reservation, reports (`status_1_createdAt_-1`, `reporter_1_createdAt_-1`), the sweeper (`status_1_holdExpiresAt_1`, `status_1_checkOut_1`), the host's own lists (`owner_1_status_1`), destination searches (`status_1_cityKey_1_pricing.nightlyMinor_1`, `..._countryKey_...`), keyword search (text index) and the map box (`2dsphere`).

## Accepted, on purpose

| Query | Why it is acceptable |
|---|---|
| Destination searches (`cityKey` / `countryKey`) with the rating or newest sort | Sorted in memory, but only over one city's or country's listings; the compound index is `(status, cityKey, price)`. MongoDB may also choose the new `status`-first sort index here and filter the city while reading in order; either is fine. A third `cityKey` + sort index per order would triple the write cost for a set that is small by construction |
| Guest "Your trips" tabs, the host's own lists, a member's reports, review eligibility | Sorted in memory over one person's rows (`guest_1_createdAt_-1`, `owner_1_status_1`, `reporter_1_createdAt_-1`) |
| Moderation queues, sweeper | Sorted over the unreviewed, suspended, expired-hold or ended-stay rows only, which the sweeper and the admins keep short |
| Admin user search (`users.admin_search`) | A case-insensitive "contains" match on name or email cannot use an index (the one listed collection scan in the registry, with its reason). Admin-only, over the users collection |
| `staynights.holdExpiresAt` (sparse) | Nothing reads nights by hold any more (the sweeper finds holds through the reservations). Left in place: dropping an index is easy to do later and hard to take back on a large collection. A candidate for the next review |

## Not covered

- **Notification count** (the card lists it): notifications (P11) do not exist yet. When they do, add `(user, readAt)` for the unread badge and record it in `src/services/queryPlans.js`.
- **Production-size timings**: see "Measured".

## How to keep it true

A new query goes into `hotQueries()` in `src/services/queryPlans.js` (filter and sort as the service builds them; say `bounded` or `scan` and why if it cannot be ordered by an index). `npm test` then fails if no declared index can answer it. An index is added in the model **and** in a new migration (never edit an applied one); `tests/unit/queryPlans.test.js` checks that the migration and the models agree.

## Measured (fill in)

Run `npm run explain -- --markdown` on your database after `npm run migrate` and paste the table here with the date and the number of listings, reservations and nights it was run against.

| Query | Plan | Keys | Docs | Returned | ms | Check |
|---|---|---:|---:|---:|---:|---|
| _(not run yet)_ | | | | | | |
