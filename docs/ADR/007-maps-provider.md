# ADR-007: Maps provider: keep Mapbox (provisional)

- Status: Provisional
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

The app already uses Mapbox GL JS in the browser and `@mapbox/mapbox-sdk` for server geocoding. One token is used for both and is shipped to every browser (finding S-05). The free tiers and terms of any provider can change, and Nominatim's usage policy forbids heavy or autocomplete-style use.

## Decision

Keep Mapbox as the provider. Use two tokens: a **server token** for geocoding that is never sent to browsers, and a **public token** restricted by URL for the browser map. Task P06-T01 re-checks the provider's current free-tier limits and terms (map loads, geocoding requests, caching restrictions) on its official pages at the time of work and confirms or revises this decision. Public listing locations are shown approximately (task P06-T02), never the exact point.

## Consequences

- Status is **provisional until P06-T01** records the verified limits.
- Needs `.env.example` entries for both tokens and a way to tell whether the current token is public (`pk.`) or secret (`sk.`).
- Leaflet with OpenStreetMap tiles remains the documented fallback; switching would touch the map module and geocoding service only.
- Free tier is not assumed unlimited or permanent.

## Alternative rejected

Leaflet + OpenStreetMap tiles + Nominatim as the default. Rejected for now: Nominatim's policy forbids heavy and autocomplete use, and it would replace working code without a verified need.
