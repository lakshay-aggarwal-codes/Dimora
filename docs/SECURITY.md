# Security review: input and injection (P17-T02)

Reviewed 2026-10-25 against the code at task 75. Method: reading every place that
takes request input (controllers, middleware, validation, services) and every
view that prints it, then writing standing tests for what was found.
**Probes against a running app were not made** (no database or network in the
review environment); the tests below were written to run in `npm test`.
Evidence labels: **code review** (read in the source), **test** (a test pins it),
**not covered**.

## Results

| Threat | Where it could happen | Defence | Evidence |
|---|---|---|---|
| Operator injection (`email[$ne]=`, `$where`, `a.b=1`) | any form or query value that reaches a database filter or update | `src/middleware/inputGuard.js` refuses keys with `$` or `.` and prototype names, in query and body, at app level and after every multer middleware; Joi schemas and the query parsers also reject non-string values | `tests/unit/inputGuard.test.js`, `tests/integration/inputGuard.routes.test.js`, `tests/unit/inputParsers.test.js` (field-by-field fuzz) |
| Prototype pollution via nested keys | form and query parsing | the same guard (`__proto__`, `constructor`, `prototype`) | same tests |
| Oversize bodies | forms and uploads | form parser: 100 kb and 1000 parameters (explicit); multer: 5 MB per image, 100 KB per text field, 100 fields; both answer 413/400 through the error handler | route test (413 cases); static test for the multer limits |
| Deeply nested or huge input | form parsing | guard refuses more than 8 levels, 5000 values, NUL bytes | `inputGuard.test.js` |
| HTTP parameter pollution (`?q=a&q=b`) | query strings | duplicates are allowed to arrive as arrays (checkboxes and `?ids=` need that); every parser either rejects an array or takes plain values; the fuzz test feeds repeated values to every parser | `inputParsers.test.js`, `inputGuard.routes.test.js` |
| Stored or reflected XSS | every field printed in a view | EJS escaping (`<%= %>`) everywhere; a static test lists every raw print in `views/` and fails on a new one; no `innerHTML`, `eval`, inline handler or `javascript:` link in views or `public/js` | `securityReview.static.test.js`; per-view tests for place names (`neighborhood.view.test.js`, `nearbyStatus.view.test.js`), compare and wishlist pages |
| XSS through JSON-LD | `<script type="application/ld+json">` in `views/listings/show.ejs` | the local `structuredData` is never set today (nothing printed). `src/utils/jsonLd.js` escapes `<`, `>`, `&` and line separators; P18-T05 must use it | `tests/unit/jsonLd.test.js` |
| CRLF / header injection | redirects built from request values | Node refuses CR/LF in header values; Express encodes them in `res.redirect`; `safeRedirectPath` refuses control characters, foreign hosts and `//`, `\` | `inputGuard.routes.test.js` (CRLF cases) |
| Open redirect | `next`, return-to paths | `safeRedirectPath` (earlier task) plus the same-site check in the saved-stays redirect | existing tests, route test |

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | Medium (code review of our side only: nothing validates the login body; how passport-local-mongoose then builds its query was not read here, and the attack was not reproduced) | `POST /login` passes `req.body.username` to passport without validation. With `username[$ne]=` an object can reach the user lookup. As far as I know the password check still has to pass, so no login bypass is claimed, but the lookup could pick a user other than the one named, or fail with a 500. | Fixed by the guard (rejects the request before the login handler). |
| F2 | Low | multer accepted any number of text fields up to 1 MB each. | Fixed: 100 KB per field, 100 fields. |
| F3 | Low | Three templates (`partials/nearby-status.ejs`, `partials/neighborhood.ejs`, `compare/index.ejs`) had a comment that contained a template tag. EJS ends a comment at the first closing tag, so the rest of the comment text would have been printed into the page. Not exploitable (the text was ours), but wrong. Found by the new static test. | Fixed; the static test now fails on any such comment. |
| F4 | Info | `<%- structuredData %>` is a raw print with a variable nobody sets. Harmless now, dangerous the day it is set from listing text. | Helper and test added; allow-list entry says who must use it. |
| F5 | Info | Express 5 keeps `a[$ne]=1` in a query string as one flat key, so query objects are not nested; form bodies (`extended: true`) and multipart bodies are. | The guard covers both shapes. |

## Not covered

- Messages (P11-T02) and notification text do not exist yet; when they do, add their fields to `securityReview.static.test.js` and their parsers to `inputParsers.test.js`.
- No browser or running-server probe; the guard and parsers are tested in isolation and through a small Express app, not through the real `app.js` with a database.
- Database-level checks (a hostile string stored and read back) rely on EJS escaping at output; there is no input-side HTML stripping, by design.
- Rate limits for abuse (not injection) are P01-T09.

## How to repeat

`npm test -- tests/unit/inputGuard.test.js tests/unit/inputParsers.test.js tests/unit/securityReview.static.test.js tests/unit/jsonLd.test.js tests/integration/inputGuard.routes.test.js`
