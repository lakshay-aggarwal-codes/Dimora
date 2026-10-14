# ADR-007: Maps provider: keep Mapbox, two tokens

- Status: Accepted (2026-10-15, P06-T01). Free-tier figures below are **not yet confirmed on Mapbox's own pages**: see "Verification status".
- Date: 2026-10-14 (provisional), 2026-10-15 (decided)
- Source: P00-T03, P06-T01; `MASTER_ROADMAP.md`

## Context

The app uses Mapbox GL JS in the browser (detail-page map) and `@mapbox/mapbox-sdk` on the server (geocoding when a host saves a listing). The free tiers and terms of any provider can change, and Nominatim's usage policy forbids heavy and autocomplete-style use.

## Decision

Keep Mapbox. Use two tokens:

| Token | Env key | Used by | Rules |
|---|---|---|---|
| Server | `MAPBOX_SERVER_TOKEN` | `src/services/geocoding.js` only | Never sent to a browser. Prefer a secret (`sk.`) token with only the geocoding scope. |
| Public | `MAPBOX_PUBLIC_TOKEN` | Browser map (`data-token` on `#map`) | Must be a public (`pk.`) token, restricted by URL in the Mapbox account (list the production domain and `http://localhost:*`). |

Startup (`src/config/env.js`) enforces the split: a public token that starts with `sk.` is an error in production (warning elsewhere), and using the **same** token for both is an error in production (warning elsewhere). The legacy `MAP_TOKEN` name fills both keys and therefore triggers that warning. Tests assert that a rendered page contains the public token and never the server token (`tests/integration/mapbox.tokens.test.js`).

The `Referrer-Policy: strict-origin-when-cross-origin` header (P01-T09) keeps URL-restricted tokens working.

## Verification status

Figures reported by several third-party pricing summaries (2026), **not read from mapbox.com in this task** (the sandbox could not reach it):

- Mapbox GL JS web: 50,000 map loads per month free, then about $5 per 1,000. One load covers a session (unlimited pan/zoom, up to 12 hours).
- Geocoding with `mapbox.places` (temporary): 100,000 requests per month free, then about $0.75 per 1,000. Results may only be used for the current session, not stored.
- Geocoding with `mapbox.places-permanent` (results stored in a database): no free tier, about $5 per 1,000.
- A payment method may be required on the account even for the free allowance.

**The owner must confirm these on https://www.mapbox.com/pricing and in the Mapbox terms before relying on them.**

## Storage of geocoded coordinates

Dimora saves the geocoded point on the listing (`geometry`). That is storing a geocoding result, which Mapbox licenses under the *permanent* mode, not the free temporary one. Volume is tiny (one lookup per listing save, not per page view or keystroke), so the cost is small, but it is not zero and not covered by the free allowance.

The code supports both: `MAPBOX_GEOCODING_PERMANENT=true` makes `geocodeAddress` call `mapbox.places-permanent`. It is **off by default** because it needs a Mapbox account that is allowed to use permanent geocoding; if the account is not, saves fail with the "temporarily unavailable" message. Decision for the owner: for a public deployment, enable it (and accept the per-request cost) or replace geocoding with a provider whose terms allow storage. Demo and local use stay on the default.

## Consequences

- `.env.example` documents both tokens and the permanent switch.
- Public listing locations are shown approximately (P06-T02), never the exact point.
- Map loads happen once per detail-page view; P06-T03/T04 must not create extra loads (single map instance per page, no re-initialising).
- Autocomplete (P05-T06) uses existing listing cities, not Mapbox, so geocoding volume stays low.
- Leaflet with OpenStreetMap tiles remains the documented fallback; switching would touch `public/js/map.js`, the CSP in `src/middleware/security.js` and `src/services/geocoding.js` only.
- None of the free tiers is assumed unlimited or permanent.

## Alternative rejected

Leaflet + OpenStreetMap tiles + Nominatim as the default. Rejected for now: Nominatim's policy forbids heavy and autocomplete use, and it would replace working code without a verified need.
