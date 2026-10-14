# Baseline defect verdicts (P00-T02)

Run date: 2026-10-14 · Node v22.22.2 · repo state: original code + P00-T01 applied.

## How this was verified

Sandbox run, **no real Atlas, Cloudinary or Mapbox**. The real `app.js` was started with only these stubbed: `mongoose.connect`, the Mongo session store (memory store instead), passport-local authentication, `cloudinary.uploader.upload_stream`, and the Listing/Review database calls. Requests were real HTTP calls (login, session cookie, multipart forms) against the real routes, middleware, controllers, views and error handler.

Verdicts:
- **CONFIRMED** — reproduced by the run above (database/services stubbed).
- **CONFIRMED (code)** — established by reading the code or package source; no runtime reproduction was needed.
- **LIVE CHECK PENDING** — behaviour needs a browser or live services. Owner checklist: `docs/tasks/P00-T02.md`. Record results in the last column.

## Defect register

| ID | Verdict | One-line reproduction / evidence | Owner live result |
|---|---|---|---|
| D-01 | CONFIRMED, **fixed by P00-T01** | Original repo: `npm ci` → `ERESOLVE`. After Q1: `npm ci` exits 0 | — |
| D-02 | CONFIRMED | Logged in, `POST /listings` (multipart or urlencoded) → HTTP 500, "Cannot read properties of undefined (reading 'listing')" | |
| D-03 | CONFIRMED | Owner, `PUT /listings/:id` multipart, with **or without** a new file → HTTP 500, "Cannot read properties of undefined (reading 'url')" | |
| D-04 | CONFIRMED + LIVE CHECK PENDING | Rendered `show.ejs` contains `const listing = ""`; `public/js/map.js` reads `listing.geomtry`. Blank map in the browser still to be observed | |
| D-05 | CONFIRMED (validation) + LIVE CHECK PENDING | All 29 `init/data.js` entries fail `Listing` validation (`geometry` missing; none has it). Hard-coded owner id `6aaa6f18c29707e1bde55246` and `127.0.0.1` URL in `init/index.js` are by code; nonexistence of that user needs a DB | |
| D-06 | CONFIRMED | `GET /listings?search=Goa` → `Listing.find` called with `{}`; the query is ignored | |
| D-07 | CONFIRMED (code) | `views/listings/index.ejs` L384–385: literal `+18% GST` text; filter strip is `<div class="filter">` with no field or handler tied to data | |
| D-08 | CONFIRMED | `GET /`, `/privacy`, `/terms` → 404. Rendered navbar has `href="/signup "` (trailing space) and "Login out"; "Dimora your home" links to `/listings/new` (login redirect says "to create new listing") | |
| D-09 | CONFIRMED | Field is `crestedAt`; two reviews created 20 ms apart have identical default timestamps (`default: Date.now()` is called at load) | |
| D-10 | CONFIRMED | `GET /listings/:id/edit` with missing listing → 500 "Cannot read properties of null (reading 'owner')"; `isReviewAuthor` with missing review → 500. Malformed id: real Mongoose throws `CastError` (no DB needed) and the handler returns 500 | |
| D-11 | CONFIRMED | `createListing` with an empty geocoder result → `TypeError: Cannot read properties of undefined (reading 'geometry')` | |
| D-12 | CONFIRMED | `POST /signup` → server log prints the user document including `salt` and `hash` (`console.log(registeredUser)`) | |
| D-13 | CONFIRMED | Owner posted two reviews on their own listing: both accepted (302), 2 stored. Default radio `no-rate` has `value="1"` and is `checked` | |
| D-14 | CONFIRMED | Listing without `price` → show page 500 "Cannot read properties of undefined (reading 'toLocaleString')" | |
| D-15 | CONFIRMED (code) | `updateListing` never geocodes; no `cloudinary.uploader.destroy` anywhere in `controllers/` | |
| D-16 | CONFIRMED (code) | `multer-storage-cloudinary@4.0.0` README documents Cloudinary upload params and nothing named `allowedFormats`; the option was never enforced. No size/count limit existed. Live `.gif` test is impossible at baseline because edit is broken (D-03). Q1 replaced this with an explicit PNG/JPEG filter and a 5 MB limit | |
| D-17 | CONFIRMED | Original `package.json`: `name: "project"`, no `start`/`dev`, `main: "index.js"` (file does not exist), no `engines` (engines added by Q1) | |
| D-18 | CONFIRMED (code) + LIVE CHECK PENDING | `style.css` L12 `height: 5 rem` (invalid), L138 `#map { width: 80vh }`; `col-6 offset-3` on login/signup/error. Phone-width look needs a browser | |

## Security findings observed during the run

| ID | Verdict | Evidence |
|---|---|---|
| S-06 | CONFIRMED | The error page prints raw `err.message`; for D-14 it included an absolute server file path and template source lines |
| D-12 / S-07 | see D-12 | Password hash and salt in logs |

Other S-01…S-05, S-07…S-10 were not re-tested here; they remain code-read findings handled in P01-T01, T09, T10 and P02.

## Not covered / limits

- Real Atlas, Cloudinary and Mapbox behaviour, and anything visual, were not tested (checklist in `docs/tasks/P00-T02.md`).
- Passport authentication and database queries were stubbed, so signup uniqueness, real login failures and data-dependent behaviour are not verified.
