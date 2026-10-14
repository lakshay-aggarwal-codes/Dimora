# ADR-001: Keep the monolith and server-rendered EJS

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

The app is a small Express 5 + Mongoose + EJS application (about 2,000 lines). The product needs search, booking, pricing, messaging and dashboards, but traffic is college/demo scale and there is one developer. The roadmap (section 7) compares evolving the current stack with a rewrite.

## Decision

Keep a single Express monolith with server-rendered EJS (ejs-mate layouts, partials). Grow it by adding layers inside the same codebase: `services/` for business rules, `policies/` for authorization, `config/` for validated env, `jobs/` for in-process timers, `scripts/`, `tests/`. Browser behaviour (date picker, quote panel, map, wishlist toggle) is small vanilla JS modules. JSON endpoints exist only as helpers for quote, availability and map data.

## Consequences

- One deployable, one repo, simple local run on Windows.
- Rules live in services, so they can be unit-tested without HTTP.
- Real-time features use polling, not websockets.
- No SPA tooling, bundler or client-side routing to learn or maintain.
- Pages are less interactive than a SPA; accepted.

## Alternative rejected

A single-page app (React/Vue) with a separate API, or moving to SQL. Rejected: weeks of rework, a second deployable and a new data layer, with no demonstrable capability gain at this scale. MongoDB handles every planned query.
