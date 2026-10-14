# ADR-006: CSRF protection approach

- Status: Provisional
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

Authenticated forms (including logout, currently a GET) are exposed to cross-site request forgery. `csurf` was the usual Express package but is deprecated and must not be used.

## Decision

Add CSRF protection to every state-changing request (POST/PUT/PATCH/DELETE, including method-override forms), and make logout a POST. Preferred implementation: the `csrf-csrf` package (double-submit cookie), or a small session-based synchronizer token if that package is unsuitable. **Maintenance status, license and compatibility with Express 5 are verified at install time** in task P01-T10 before the choice is final. Tokens are exposed to views via `res.locals` and sent as a hidden field or header; session cookies get `sameSite` and `secure` (in production) settings in the security baseline (P01-T09).

## Consequences

- Every form template needs a hidden token field; multipart forms must make the token available before or via the query string/header (decided in P01-T10).
- Tests must obtain a token before posting.
- A tiny home-grown synchronizer token is acceptable if the package is not maintained; either way the behaviour is covered by tests.
- Logout stops being a link and becomes a small form.

## Alternative rejected

`csurf` (deprecated), or relying on `sameSite` cookies alone. Cookies alone are not defence in depth and do not protect older browsers or same-site attacks.
