# ADR-006: CSRF protection approach

- Status: Accepted (P01-T10, 2026-10-14)
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`; implemented in P01-T10

## Context

Authenticated forms (including logout, currently a GET) are exposed to cross-site request forgery. `csurf` was the usual Express package but is deprecated and must not be used.

## Decision

Add CSRF protection to every state-changing request (POST/PUT/PATCH/DELETE, including method-override forms), and make logout a POST. Preferred implementation: the `csrf-csrf` package (double-submit cookie), or a small session-based synchronizer token if that package is unsuitable. **Maintenance status, license and compatibility with Express 5 are verified at install time** in task P01-T10 before the choice is final. Tokens are exposed to views via `res.locals` and sent as a hidden field or header; session cookies get `sameSite` and `secure` (in production) settings in the security baseline (P01-T09).

## Outcome (P01-T10)

The small home-grown synchronizer token was chosen: no new dependency, and it needs only the session that already exists. `src/middleware/csrf.js`:

- one random 256-bit token per session (`req.session.csrfToken`), exposed as `res.locals.csrfToken`;
- every request except GET/HEAD/OPTIONS must send it as the `X-CSRF-Token` header, the `_csrf` query parameter or the `_csrf` body field (constant-time comparison); otherwise a 403 page (JSON for `/api` and `Accept: application/json`);
- mounted after the session and the urlencoded parser and before multer and all routers, so no route can run without it;
- forms use `views/includes/csrf.ejs` (hidden field); multipart forms put `_csrf` in the action URL because multer has not parsed the body yet; the layout carries `<meta name="csrf-token">` for `fetch` calls (`headers: { "X-CSRF-Token": ... }`);
- login and logout regenerate the session, so a form rendered before either is rejected and the visitor is asked to reload.

## Consequences

- Every form template needs a hidden token field; multipart forms must make the token available before or via the query string/header (decided in P01-T10).
- Tests must obtain a token before posting.
- A tiny home-grown synchronizer token is acceptable if the package is not maintained; either way the behaviour is covered by tests.
- Logout stops being a link and becomes a small form.

## Alternative rejected

`csurf` (deprecated), or relying on `sameSite` cookies alone. Cookies alone are not defence in depth and do not protect older browsers or same-site attacks.
