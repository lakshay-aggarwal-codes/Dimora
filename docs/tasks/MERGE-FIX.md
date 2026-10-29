# Merge fix (after Q84, Q86, Q92, Q98, Q101, Q104)

Date: 2026-10-28.

## Cause
Those six zips were built on a copy of the repository that did not contain the work of the other tasks, and a zip replaces whole files. Where a file was also edited by another task, one side was lost. The Git history was used to find what was lost, and each file was re-merged on top of the current version.

## Restored: my changes that were missing
`.env.example`, `src/config/env.js` (TRUST_PROXY_HOPS, EMAIL_*), `src/app.js` (email routes and limiters stay; nothing removed), `src/controllers/{checkout,host}.js` (the "confirm your email" gate), `src/validation/index.js` (forgot/reset schemas), `src/validation/searchQuery.js` and `src/utils/searchUrl.js` (purpose), `src/controllers/search.js`, `tests/helpers/routeMatrix.js` (my routes), `views/account/index.ejs` (unconfirmed notice), `views/includes/navbar.ejs` (destination suggestions), `views/listings/show.ejs` (trust indicators).

## Restored: other tasks' lines that my zips had removed
`package.json` (`seed:demo`), `src/app.js` (notification preferences router and mailer, SEO router and layout helpers), `src/controllers/listing.js` (accessibility labels, Open Graph image, noindex for drafts), `src/controllers/search.js` and `src/validation/searchQuery.js` and `src/utils/searchUrl.js` (radius filter), `tests/helpers/routeMatrix.js` (robots.txt, sitemap.xml), `views/layouts/boilerPlate.ejs` (SEO tags), `views/listings/index.ejs` ("Save this search").

## Not covered
Files that my zips never touched, and `docs/PROGRESS.md`, `docs/SECURITY.md`, `docs/ADR/README.md`. Failures in suites unrelated to these files (for example conversations, modifications, trips change) need a fresh test run to be analysed.
