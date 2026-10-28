# Demonstration kit (P19-T04)

A five-minute scripted walkthrough of Dimora, the three engineering points worth showing, and what to say when someone asks what is missing. It is written for the demo accounts and places made by `npm run seed:demo` ([docs/tasks/P19-T02.md](tasks/P19-T02.md)).

`tests/unit/docsDemo.test.js` reads this file: the commands, files, routes, accounts, places and the price example below are checked against the code, so a change that makes this page false fails a test.

**What this kit does not contain: screenshots or GIFs.** They were not made, because the author had no browser, database or Mapbox/Cloudinary account when writing it. [docs/demo/SHOTS.md](demo/SHOTS.md) lists the ten pictures to take, with file names and the exact steps, so they can be made in about fifteen minutes from the walkthrough below.

## 1. Before you start (10 minutes, not part of the five)

1. A MongoDB you can reach and a filled `.env` (see the README). Photos need Cloudinary and the maps need Mapbox; without them the pages load but uploads and maps do not work.
2. **Re-seed on the day:** `npm run seed:demo -- --reset`. The two demo booking requests hold their nights for 24 hours, then the housekeeping job expires them, so an old seed shows an empty "Waiting for your answer" list. The passwords are printed **only when an account is created or rotated** and are stored nowhere: on a first seed copy the four that are printed; on a database that already has the accounts add `--rotate-passwords` to get new ones.
3. Start the app (`npm run dev`) and open **three browser profiles** (or one normal and two private windows): guest, second guest, host. A fourth window for the admin is needed only for the last minute.
4. If the app is on a free Render service, wake it first: `node scripts/smoke-deploy.js https://<your-service>.onrender.com` (the `smoke:deploy` entry that P19-T03 says it added is missing from `package.json`, so call the script directly). A sleeping service needs about a minute ([docs/DEPLOYMENT.md](DEPLOYMENT.md)).
5. Pick the dates now. The script uses **a stay from Monday to Thursday, about three weeks ahead** (no weekend night, so the price below is exact) and **a second stay of three nights a week after that** at the villa.

| Role | Username | Used in |
|---|---|---|
| Guest | `dimora_demo_guest` | steps 1-3 |
| Second guest | `dimora_demo_guest2` | steps 3-4 |
| Host | `dimora_demo_host` | steps 4-5 |
| Admin | `dimora_demo_admin` | step 6 |

The two places used: **Charming Cottage in the Cotswolds** (books instantly, 2-night minimum, moderate cancellation, ₹1,200 a night, ₹120 cleaning) and **Historic Villa in Tuscany** (the host must accept, 3-night minimum, strict cancellation, ₹2,500 a night, ₹400 cleaning). Neither has a seeded booking, so their dates are free.

## 2. The five-minute walkthrough

Times are a guide. Say the words in the third column only if they are true for your audience; each is a fact the code supports.

| Time | Who and where | Do | Say | If it goes wrong |
|---|---|---|---|---|
| 0:00 | Visitor, `/` | Type `Cotswolds`, the Monday-Thursday dates and 2 guests, search. | "Search reads real filters from the URL, and the dates filter through the same night table that bookings use, so a taken place never shows up." | Search results empty: the dates may be taken; move a week. |
| 0:45 | Visitor, the cottage page | Scroll the photos, open the gallery with the keyboard, point at the map, then the booking panel. | "The pin is not the exact address: it is moved a few hundred metres, the same way every time, and only a confirmed guest sees the real place." | No map: Mapbox token missing, say so and carry on. |
| 1:15 | Booking panel | Show the breakdown: 3 nights, cleaning, service fee, tax. | "These numbers come from the server's price function, in whole paise. The page only displays them." Total for Monday-Thursday: see section 3. | Panel says "not available": check the minimum nights and that the dates are in the future. |
| 1:45 | Guest, checkout | Log in as the guest, press Reserve, **Confirm booking**. | "Checkout sends the total I just saw. If the price changed since, the server refuses and shows the new one instead of charging a different amount. Nothing is charged here: payment is simulated and the page says so." | A price-changed message is the feature working; accept the new total. |
| 2:15 | Guest, `/trips` | Open the new trip. | "Same total, rules copied at booking time, cancellation terms in plain words. The exact address appears only now that it is confirmed." | |
| 2:30 | Second guest, same page | In the other profile, log in as the second guest, open the cottage page, choose the **same dates**. | "Same nights, so the panel refuses. Underneath, each night is a row with a unique index on listing and date: two guests cannot both hold it, even in the same millisecond. That is tested with random and truly parallel bookings." | |
| 3:00 | Second guest, the villa | Pick the villa, three nights the week after, **Send request**. | "This host approves each stay, so this is a request. It holds the nights for 24 hours and then lapses on its own." | |
| 3:30 | Host, `/host/reservations` | Log in as the host. The request is first, with a countdown. Press **Accept**. | "Only this booking's host can answer; an admin cannot answer for them." Then switch to the second guest's `/trips`: confirmed. | A 409 page means the 24 hours lapsed: send a new request. |
| 4:00 | Host, `/host/calendar` | Open the booking calendar for the month. | "One query for every place: requests, bookings, finished stays and blocks, each shown with a letter as well as a colour." | |
| 4:30 | Admin, `/admin/listings` | Log in as the admin, open the "New" tab, open a place, **mark reviewed**, then open `/admin/audit`. | "Every admin action writes exactly one row to an append-only log, and the admin area answers 404 to everyone else." | |
| 5:00 | | Stop. | State one limitation from section 5 before questions. | |

Optional two minutes if there is time: in the guest's `/trips` use the **Past** tab, which has three finished stays for the guest, one of them (Luxury Penthouse with City Views) still inside the review window so "Write a review" shows; or cancel the cottage booking from its trip page to show the recorded refund (moderate policy; **no money moves**).

### Routes the walkthrough uses

Checked against the router by the test.

| Route | Step |
|---|---|
| `GET /` | search |
| `GET /listings` | results |
| `GET /listings/:id` | place page and booking panel |
| `GET /api/listings/:id/quote` | the panel's price |
| `GET /listings/:id/checkout` | checkout |
| `POST /listings/:id/checkout` | confirm / send request |
| `GET /trips` | trips |
| `GET /trips/:id` | one booking |
| `GET /host/reservations` | the host's inbox |
| `POST /host/reservations/:id/accept` | accept |
| `GET /host/calendar` | booking calendar |
| `GET /admin/listings` | moderation queue |
| `POST /admin/listings/:id/reviewed` | an audited action |
| `GET /admin/audit` | the audit log |

## 3. Engineering highlights

Run these from a terminal when someone asks "how do you know?". Set `$env:SKIP_DB_TESTS = "1"` first in PowerShell if there is no local MongoDB.

### The night ledger (no double booking)

- **What:** a stay is one row per night in a ledger with a unique index on (listing, date). A booking, a live hold and a host block all take rows the same way, so the database, not application code, refuses a second claim ([ADR-004](ADR/004-night-ledger-unique-index.md)).
- **Show:** `npx jest tests/unit/bookingStress.test.js`. It runs 5 seeds of 1,000 random operations (create, replay, accept, decline, cancel by either side, clock jumps, the sweeper) against in-memory fakes and checks after every step that no night has two owners, held nights equal reservation nights, no row outlives its reservation and no two live stays overlap. A failing run prints its seed; `STRESS_SEED=<n>` replays it.
- **Real concurrency:** `npx jest tests/integration/bookingStress.db.test.js` does the same against MongoDB with genuine parallel requests. **Needs a MongoDB; it was not run when this kit was written.**

### The quote engine (the total is never trusted from the browser)

- **What:** `src/services/pricing.js` turns a place and a stay into lines and a total using integer paise only, half-up rounding and rates in basis points ([ADR-002](ADR/002-money-integer-paise.md)); tax figures are labelled illustrative. The checkout stores the total the guest confirmed and the server compares it with its own.
- **Show:** `npx jest tests/unit/pricing.test.js tests/unit/quoteService.test.js`, or open `/api/listings/<id>/quote?in=YYYY-MM-DD&out=YYYY-MM-DD&guests=2` in the browser and compare it with the panel.
- **Worked example** (the cottage, Monday to Thursday, 3 nights, nothing on a weekend), in paise:

| Line | Paise | Rupees |
|---|---|---|
| 3 nights × 120,000 | 360,000 | 3,600.00 |
| Cleaning | 12,000 | 120.00 |
| Service fee, 10% of 372,000 | 37,200 | 372.00 |
| Tax (illustrative), 18% of 372,000 | 66,960 | 669.60 |
| **Total** | **476,160** | **4,761.60** |

The page may drop the trailing `.00`. Stays that include a Friday or Saturday night use the place's weekend price where it has one (the beach and city places do, about 20% higher).

### Authorization

- **What:** who may do what is a set of pure functions in `src/policies/` used by routes and by views ([docs/AUTHORIZATION.md](AUTHORIZATION.md)); the admin area answers 404 to everyone else.
- **Show:** `npx jest tests/unit/policies.test.js` (a table of roles against actions; it also fails if an action is registered but missing from the table).
- **Do not run `tests/unit/routeMatrix.test.js` live.** It is meant to list every route with its guard and fail on a route nobody decided about, but on the repository as given it **fails** (section 5), so it would show the opposite of what you want. Fix the matrix first.

## 4. Questions people ask

| Question | Honest answer |
|---|---|
| Is anyone charged? | No. Payments are simulated and labelled ([ADR-009](ADR/009-simulated-payments.md)); a cancellation calculates and records the refund. |
| Is the map location real? | The public map point is the real one moved by 300-800 m with a server secret; the exact address is shown to the host, admins and guests with a confirmed or finished stay. |
| What happens to unanswered requests? | They lapse after 24 hours. A background job does the clean-up every minute while the app is running; the lapsed hold already counts as free in search and availability. |

## 5. Honest limitations (say these before they are asked)

Checked on the repository as given when this kit was written (2026-10-29):

- **Not seen in a browser.** The author's sandbox had no browser, no MongoDB and no Cloudinary or Mapbox account. The walkthrough was assembled from the code, the seed data and the tests; the pages, the date picker, the maps and the timings have not been run end to end by the author. Do one rehearsal.
- **Two features are written but not reachable.** The guest-host **messages**, the **notification inbox pages** (the bell's count endpoint works), and **password change and account deletion** have routers that nothing mounts in `src/app.js` (the same kind of loss that [FIX-after-Q60](tasks/FIX-after-Q60.md) repaired earlier). Do not demonstrate them; the test `tests/unit/docsDemo.test.js` fails when one is mounted again, as a reminder to update this page.
- **The test suite is not green.** With `SKIP_DB_TESTS=1`, the full Jest run when this kit was written reported 31 failing suites (95 failing tests) out of 247, in the route matrix, the generated API and README checks, search and responsive pages and others. None is caused by this task. Run the single suites named in section 3, which pass; do not run all of `npm test` in front of an audience.
- **Database suites were never run by the author** (no MongoDB), including the real-concurrency booking suite.
- **No payments, no email.** Nothing is emailed, and the notification inbox is one of the unreachable pieces above.
- **One market:** rupees, India defaults, one time zone per place (Asia/Kolkata unless set).
- **On a free Render service** the first request after 15 quiet minutes takes about a minute, and nothing expires or completes while it sleeps ([docs/DEPLOYMENT.md](DEPLOYMENT.md)).
- **Demo data is demo data:** extra photos on each place are borrowed from other places; one sample cover is on a host the page policy blocks.
- **Screenshots and GIFs are not included** (see the top of this page).

## 6. After the demo

`npm run seed:demo -- --reset` makes the next demo start from the same place. Never run it against a database you care about: it refuses production and asks for `--yes` on any database that is not on your computer.
