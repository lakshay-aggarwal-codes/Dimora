# Routes

Every route the app serves, read from the routers themselves. The server renders HTML pages with EJS, so most routes are pages and form posts; the three under `/api` are the only JSON ones. `tests/unit/docsApi.test.js` fails when this table and the app disagree (a route missing here, one listed that does not exist, or a "who" that is not what the code enforces), so it can be trusted.

- **Who**: "anyone" needs no login; "signed in" needs a login (a visitor is sent to the login page and brought back); the host/guest/author rows are checked again on the server for that booking, listing or review (anyone else gets the same 404 as for something that does not exist); "admin" is a member whose `role` is `admin` (given only by `npm run make-admin`).
- **Forms**: every POST, PUT and DELETE carries a CSRF token (hidden field, or the `X-CSRF-Token` header for scripts). The HTML forms send PUT and DELETE as a POST with `_method`.
- **Rate limits**: logins, signups, the price quote and reports are limited per IP (reports also per member).
- **Errors**: HTML pages for the pages; paths under `/api` answer errors in JSON (`{ "error": { "status", "code", "message", "requestId" } }`).
- `GET /listings/:id` shows a listing only if it is published, or to its host and admins. A draft, unpublished, suspended or deleted listing is a 404 to everyone else.

## Routes

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/` | anyone | Home page: search box, categories, newest listings |
| GET | `/about` | anyone | About page |
| GET | `/privacy` | anyone | Privacy page |
| GET | `/terms` | anyone | Terms page |
| GET | `/login` | anyone | Login form |
| POST | `/login` | anyone | Log in (rate-limited per IP and per account) |
| GET | `/signup` | anyone | Signup form |
| POST | `/signup` | anyone | Create an account and log in (rate-limited) |
| POST | `/logout` | anyone | Log out (POST only, so a link on another site cannot log you out) |
| GET | `/listings` | anyone | Search and browse: destination, dates, guests, filters, sort, pages, list or map |
| POST | `/listings` | signed in | Create a listing from that form |
| DELETE | `/listings/:id` | signed in; the listing's host | Delete the listing (soft delete; host only) |
| GET | `/listings/:id` | anyone | Listing page: photos, facts, reviews, the price panel. A draft, unpublished, suspended or deleted listing is a 404 for everyone but its host and admins |
| PUT | `/listings/:id` | signed in; the listing's host | Save the edit form (host only) |
| GET | `/listings/:id/checkout` | signed in | Checkout page: the stay, the rules, the cancellation terms and the final price for the dates in the query |
| POST | `/listings/:id/checkout` | signed in | Book (instant) or send the request (host approval). Needs the total the guest confirmed and an idempotency key |
| GET | `/listings/:id/edit` | signed in; the listing's host | Edit form (host only) |
| POST | `/listings/:id/images` | signed in; the listing's host | Upload photos (host only) |
| DELETE | `/listings/:id/images/:imageId` | signed in; the listing's host | Delete a photo (host only) |
| PUT | `/listings/:id/images/:imageId` | signed in; the listing's host | Change a photo's text (host only) |
| PUT | `/listings/:id/images/:imageId/cover` | signed in; the listing's host | Make a photo the cover (host only) |
| PUT | `/listings/:id/images/:imageId/move` | signed in; the listing's host | Move a photo one place (host only) |
| PUT | `/listings/:id/images/order` | signed in; the listing's host | Save a new photo order (host only) |
| POST | `/listings/:id/reviews` | signed in; the guest of a completed stay | Write the review of a completed stay (the guest of that stay only) |
| DELETE | `/listings/:id/reviews/:reviewId` | signed in; the review's author | Delete a review |
| PUT | `/listings/:id/sections/:key` | signed in; the listing's host | Save one section of the listing from its own form (host only) |
| GET | `/listings/new` | signed in | Create-a-listing form (the older one-page form; the wizard under /host is the main way) |
| GET | `/users/:id` | anyone | Public profile of a member |
| GET | `/account/profile` | signed in | Edit your own profile |
| PUT | `/account/profile` | signed in | Save your profile (name, bio, avatar) |
| GET | `/trips` | signed in | Your trips: upcoming, pending, past, cancelled |
| GET | `/trips/:id` | signed in | One booking: dates, price, rules, cancellation terms, refund, review prompt |
| POST | `/trips/:id/cancel` | signed in; the booking's guest | Cancel a booking (guest); the refund is calculated and recorded |
| GET | `/reports` | signed in | Your reports and their status |
| POST | `/reports` | signed in | Send a report (rate-limited; one open report per target) |
| GET | `/reports/new` | signed in | Report form for a listing, a review or a member (`?kind=&id=`) |
| GET | `/host/calendar` | signed in | All your listings in one month |
| GET | `/host/listings` | signed in | Your listings |
| POST | `/host/listings` | signed in | Create a draft and go to step 1 |
| GET | `/host/listings/:id` | signed in; the listing's host | Continue the wizard where you left it |
| GET | `/host/listings/:id/calendar` | signed in; the listing's host | The listing's availability calendar |
| POST | `/host/listings/:id/calendar/blocks` | signed in; the listing's host | Block a range of nights |
| POST | `/host/listings/:id/calendar/unblock` | signed in; the listing's host | Free blocked nights |
| POST | `/host/listings/:id/publish` | signed in; the listing's host | Publish (only when the checklist passes) |
| GET | `/host/listings/:id/status` | signed in; the listing's host | Status page: the readiness checklist, publish/unpublish, a moderation notice |
| GET | `/host/listings/:id/steps/:n` | signed in; the listing's host | One wizard step |
| POST | `/host/listings/:id/steps/:n` | signed in; the listing's host | Save one wizard step |
| POST | `/host/listings/:id/unpublish` | signed in; the listing's host | Take the listing off the site |
| GET | `/host/listings/new` | signed in | Start the listing wizard |
| GET | `/host/reservations` | signed in | Booking requests and upcoming stays |
| POST | `/host/reservations/:id/accept` | signed in; the booking's host | Accept a request |
| POST | `/host/reservations/:id/cancel` | signed in; the booking's host | Cancel a confirmed stay (reason required; the guest is refunded in full) |
| POST | `/host/reservations/:id/decline` | signed in; the booking's host | Decline a request (optional reason) |
| GET | `/api/listings/:id/availability` | anyone | JSON: free and taken nights of a listing for the date picker |
| GET | `/api/listings/:id/quote` | anyone | JSON: the price and any rule problems for `?in=&out=&guests=`; when the nights are taken, up to 3 free stays of the same length nearby |
| GET | `/api/search/map` | anyone | JSON (GeoJSON): the public points of the stays in the current search, for the map |
| GET | `/admin` | admin (anyone else gets a 404) | Admin home |
| GET | `/admin/audit` | admin (anyone else gets a 404) | The audit log of administrative actions |
| GET | `/admin/listings` | admin (anyone else gets a 404) | Moderation queues: reported, new, suspended |
| GET | `/admin/listings/:id` | admin (anyone else gets a 404) | One listing for moderation, with its open reports |
| POST | `/admin/listings/:id/restore` | admin (anyone else gets a 404) | Restore a suspended listing (reason required; audited) |
| POST | `/admin/listings/:id/reviewed` | admin (anyone else gets a 404) | Mark a listing as reviewed (audited) |
| POST | `/admin/listings/:id/suspend` | admin (anyone else gets a 404) | Suspend a published listing (reason required; audited) |
| GET | `/admin/users` | admin (anyone else gets a 404) | Find members |
| GET | `/admin/users/:id` | admin (anyone else gets a 404) | One member's account page and admin history |
| POST | `/admin/users/:id/reinstate` | admin (anyone else gets a 404) | Reinstate an account (reason required; audited) |
| POST | `/admin/users/:id/suspend` | admin (anyone else gets a 404) | Suspend an account (reason required; audited) |

## The JSON routes

| Route | Query | Answer |
|---|---|---|
| `GET /api/listings/:id/availability` | `from`, `to` (`YYYY-MM-DD`) | `{ from, to, unavailable: [dates], rules }`: the nights nobody can book in that range (a booking, a pending request and a host block look the same: never who or why) and the stay rules the date picker applies. Never cached |
| `GET /api/listings/:id/quote` | `in`, `out` (`YYYY-MM-DD`), `guests` | `{ in, out, guests, bookable, problems, quote, expectedTotalMinor }`. `quote` is the price built by the pricing service (integer paise: lines, taxes, total); `problems` are the reasons a stay cannot be booked (nights taken, minimum stay, notice...). When the nights are taken the answer also has `alternatives: { radiusDays, windows }`: up to 3 free stays of the same length within 14 days. This is the same price the checkout charges (and the booking stores) |
| `GET /api/search/map` | the same query as `/listings` | GeoJSON of the public points of the stays in the search (never the exact address) |

## Keeping this file true

`src/utils/routeList.js` reads the routers; `tests/unit/docsApi.test.js` compares. After adding a route, add its row here (the test names the missing one).
