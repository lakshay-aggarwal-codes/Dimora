# FIX-after-Q60 - repair after overlapping task zips

Date: 2026-10-24 - Not a roadmap task. New dependencies: none. No migration.

## What happened
VS Code showed 80 problems. They were failing tests, and almost all came from one cause: **each task zip carries whole files**, so when a zip made from an older copy of a file is unpacked over a newer one, the newer task's changes disappear. Tasks 54, 57 and 60 (made from my copy) and the review tasks (55, 56, 63, made elsewhere) were applied in an order that overwrote each other. I compared your repository (the zip you sent) with mine file by file.

## What was lost, and what is back
| File | Lost | Restored |
|---|---|---|
| `src/controllers/trips.js`, `src/services/trips.js`, `views/trips/show.ejs` | task 54: the cancel button, refund preview, "how it ended" box, `POST /trips/:id/cancel` handler | re-applied on top of your versions (your review additions are kept) |
| `src/routes/host.js`, `views/host/reservations.ejs` | task 54: `POST /host/reservations/:id/cancel` and the host's cancel form | re-applied |
| `views/includes/navbar.ejs` | task 57: "Your reports" in the account menu | re-applied (your "Booking calendar" link is kept) |
| `public/css/components.css` | task 51: the checkout page's styles | appended again |
| `views/listings/show.ejs` | **P12-T01/T02**: the shared review form, the "Reviews come from guests who stayed here." note, newest-first list with month and year, the "posted before bookings existed" note | rebuilt from the tests (`reviews.routes.test.js`) and the controller's data (`reviewable`, `reviewList`); my report links and suspended wording kept |
| `src/controllers/listing.js` (listing page) | **P04-T07** (lost in an earlier merge, as the P12-T02 report said): the normal 404 page for missing/draft/unpublished/suspended/deleted listings and non-ids, `facts`, `amenityGroups`, structured data | restored from `docs/tasks/P04-T07.md` and the helpers that still existed (`utils/amenities.js`, `utils/structuredData.js`) |
| `docs/PROGRESS.md` | the rows of tasks 54, 57 and 60 | added back (and one row for this repair; task 51 never had a row, only its report) |

## Two of my own tests fixed
- `tests/integration/sweeper.db.test.js` ("a stay is completed once check-out has passed"): the test booked two overlapping stays of the same listing, so the second booking was correctly refused. The second stay now uses a different night. (This was the real MongoDB failure in your Problems list.)
- `tests/integration/reports.views.test.js` and `tests/integration/checkout.test.js`: the listing page asks the database whether a signed-in viewer has a stay to review; the tests now answer that question themselves.

## Results (sandbox, no database)
- Before (your zip): 52 failed, 2882 passed. After: **8 failed -> 7 after the last test fix**, ~2930 passed. The checkout, cancellation, reports, review, listing detail and lifecycle suites all pass.
- The 7 that remain are not touched here: `listings.filters`, `listings.search`, `search.map.api`, `pages.responsive`, `responsiveViews`, `searchQuery` (category strip, filter panel, edit form labels, "names and aliases", map bbox). They are in the search/filter area and were already failing before task 54; they look like the same kind of lost merge and deserve their own repair task.
- **Not run:** the `*.db.test.js` suites (they need MongoDB). Several in your list (`listing.lifecycle.db`, `host.wizard.db`, `listings.crud.db`, `listings.show.db`) expected the 404 page that the restored listing controller now gives; the others I cannot judge from here.

## How to avoid this from now on
1. After unzipping a task zip run `git diff --stat` and look at every file that is **not new**: it should contain only that task's changes. If a file you changed in another task shows a large diff, do not commit; send it to me.
2. Commit after every task (you already do), and send the **current repository zip** with each new task: I build the next zip from it, not from my copy.
