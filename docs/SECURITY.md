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
| XSS through JSON-LD | `<script type="application/ld+json">` in `views/listings/show.ejs` | the local `structuredData` is not set by any controller today (nothing printed). `listingJsonLd` (`src/utils/structuredData.js`, P04-T07) already builds the JSON with `<`, `>`, `&` and line separators escaped; `src/utils/jsonLd.js` exposes the same escaping. Whoever wires it up (P18-T05) must use one of them | `tests/unit/jsonLd.test.js` |
| CRLF / header injection | redirects built from request values | Node refuses CR/LF in header values; Express encodes them in `res.redirect`; `safeRedirectPath` refuses control characters, foreign hosts and `//`, `\` | `inputGuard.routes.test.js` (CRLF cases) |
| Open redirect | `next`, return-to paths | `safeRedirectPath` (earlier task) plus the same-site check in the saved-stays redirect | existing tests, route test |

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | Medium (code review of our side only: nothing validates the login body; how passport-local-mongoose then builds its query was not read here, and the attack was not reproduced) | `POST /login` passes `req.body.username` to passport without validation. With `username[$ne]=` an object can reach the user lookup. As far as I know the password check still has to pass, so no login bypass is claimed, but the lookup could pick a user other than the one named, or fail with a 500. | Fixed by the guard (rejects the request before the login handler). |
| F2 | Low | multer accepted any number of text fields up to 1 MB each. | Fixed: 100 KB per field, 100 fields. |
| F3 | Low | Three templates (`partials/nearby-status.ejs`, `partials/neighborhood.ejs`, `compare/index.ejs`) had a comment that contained a template tag. EJS ends a comment at the first closing tag, so the rest of the comment text would have been printed into the page. Not exploitable (the text was ours), but wrong. Found by the new static test. | Fixed; the static test now fails on any such comment. |
| F4 | Info | `<%- structuredData %>` is a raw print with a variable nobody sets. Harmless now, dangerous the day it is set from listing text. `listingJsonLd` already escapes correctly (an earlier task); `jsonLd.js` was added as a second copy of the same escaping and now just points at it. | Test and allow-list entry say who must use it. |
| F5 | Info | Express 5 keeps `a[$ne]=1` in a query string as one flat key, so query objects are not nested; form bodies (`extended: true`) and multipart bodies are. | The guard covers both shapes. |

## Not covered

- Messages (P11-T02) and notification text do not exist yet; when they do, add their fields to `securityReview.static.test.js` and their parsers to `inputParsers.test.js`.
- No browser or running-server probe; the guard and parsers are tested in isolation and through a small Express app, not through the real `app.js` with a database.
- Database-level checks (a hostile string stored and read back) rely on EJS escaping at output; there is no input-side HTML stripping, by design.
- Rate limits for abuse (not injection) are P01-T09.

## How to repeat

`npm test -- tests/unit/inputGuard.test.js tests/unit/inputParsers.test.js tests/unit/securityReview.static.test.js tests/unit/jsonLd.test.js tests/integration/inputGuard.routes.test.js`

# Dependencies, secrets and configuration (P17-T04)

Reviewed 2026-10-25 on the files of the repository (no `.git` folder was available).

## What was checked

| Check | Result | Evidence |
|---|---|---|
| Known vulnerabilities in dependencies (`npm audit`) | **Not run**: no network in the review environment. Run `npm run audit:deps` (production dependencies, high and above) and read the output; CI already prints the full report on every push (report only, never fails the build). | not covered |
| Pinned versions | `package.json` uses `^` ranges (normal); `package-lock.json` (lockfile v3, 684 packages) pins every version, every package comes from `registry.npmjs.org` and has an integrity hash; the lockfile matches `package.json`. CI installs with `npm ci`. Deploy with `npm ci --omit=dev`. | code review (script check of the lockfile) |
| Unused dependencies | None found: every entry of `dependencies` and `devDependencies` is required somewhere. | code review (text search, not a proof) |
| Secrets in the working tree | None found. Scanned every text file (including the UTF-16 test reports and the zip's contents) for database URIs with passwords, Mapbox secret tokens, private keys, cloud and payment keys, and literal values of secret settings. Only test fixtures (fake passwords) matched the loose rule. `.env` is not in the repository and is git-ignored. | `npm run scan:secrets`, `tests/unit/secretScan.test.js` |
| Secrets in git history | **Not scanned** (no `.git` in the files reviewed). Run: `git log --all -p \| node scripts/scan-secrets.js --stdin` (PowerShell: `git log --all -p \| node scripts/scan-secrets.js --stdin` works the same). The old session secret was known to have been committed once; `src/config/env.js` already refuses it, but it must stay rotated. | not covered |
| Configuration | `src/config/env.js` fails at start-up on missing or weak settings (32+ character session secret, known leaked secret, placeholders, one Mapbox token for both jobs). New `npm run preflight` adds the deployment rules (below). | `tests/unit/preflight.test.js` |
| Stray files | The repository root holds generated or scratch files (`jest-out.txt`, `jest-report.json`, `failures.txt`, `one.txt`, `Dimora_Claude_Guide.zip`, `data-info/`). No secrets in them, but test reports can leak environment details. They are now git-ignored; if they are already tracked, remove them from git (commands in `docs/tasks/P17-T04.md`). | code review |

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| D1 | Low | The `SESSION_SECRET` also keys the approximate public location offset (`configureLocationSecret`). Changing it logs everyone out **and moves every listing's public map point**. | Documented in the checklist: rotate only deliberately, and expect map points to move. |
| D2 | Low | Production rules were spread over comments; nothing checked `https`, a hosted database or the nearby-places contact before a deployment. | `npm run preflight` (new). |
| D3 | Info | No automatic secret scan in CI. | CI step `npm run scan:secrets` added (blocking). |
| D4 | Info | Generated reports in the repository root (see above). | Git-ignored. |

## Production checklist

Run `npm run preflight` with the production `.env` (or the host's real environment); it prints ok / warn / FAIL per item and never prints a secret.

1. `NODE_ENV=production`; `PORT` as the host expects.
2. `MONGODB_URI`: hosted database (`mongodb+srv://...`), a database user with only this database's rights, the host's IP allowed in Atlas Network Access.
3. `SESSION_SECRET`: 32+ random characters, generated with the command in `.env.example`, different from every other environment. Rotating it logs everyone out and moves public map points (D1).
4. `APP_BASE_URL`: your `https://` address (cookies are `Secure` and the app trusts `TRUST_PROXY_HOPS` proxy hops in production, default 1; set it to the number of proxies in front of the app, see `docs/DEPLOYMENT.md`).
5. `CLOUDINARY_*`: production account or folder; the API secret only on the server.
6. `MAPBOX_SERVER_TOKEN` (never sent to browsers) and a **different** `MAPBOX_PUBLIC_TOKEN` (`pk.`), restricted by URL to your domain in the Mapbox account. Read ADR-007 before turning on `MAPBOX_GEOCODING_PERMANENT`.
7. `NEARBY_CONTACT`: an email or URL for the Overpass operators (or `NEARBY_ENABLED=false`).
8. `SWEEPER_ENABLED` left on (several instances are fine).
9. Install with `npm ci --omit=dev`; Node 20.19 or newer.
10. Before each release: `npm run lint`, `npm test`, `npm run audit:deps`, `npm run scan:secrets`, `npm run migrate:dry` then `npm run migrate`.
11. After any secret was ever shown in a chat, a log or a commit: rotate it at the provider, then remove it.
