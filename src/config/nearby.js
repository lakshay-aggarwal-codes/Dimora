// Settings of the nearby-places pipeline (P15-T01). Read from the environment
// when first needed, with defaults, so a missing key never stops the app.
//
// Overpass usage policy (https://dev.overpass-api.de/overpass-doc/en/preface/commons.html,
// read 2026-10-25): the public servers are shared; stay well under about
// 10,000 queries and 1 GB of downloads per day, expect HTTP 429 when the rate
// limit (about 2 slots per IP) is hit, declare [timeout:] and [maxsize:] in the
// query, and identify the application with a User-Agent. We therefore send
// 7 small queries per refresh, one at a time, only at publish, on a host's
// manual refresh (once a day per listing) and in the retry job; never on a
// page view.
const SOURCE = "OpenStreetMap contributors";
const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// `selectors` are Overpass filters; an element matching any of them counts.
// `radiusM` is measured around the listing's precise point (never published).
const CATEGORIES = Object.freeze([
  { id: "food", label: "Food and drink", radiusM: 1500, selectors: ['["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]'] },
  { id: "grocery", label: "Groceries", radiusM: 1500, selectors: ['["shop"~"^(supermarket|convenience|greengrocer|grocery)$"]'] },
  { id: "pharmacy", label: "Pharmacies", radiusM: 2000, selectors: ['["amenity"="pharmacy"]'] },
  {
    id: "transit",
    label: "Public transport",
    radiusM: 1500,
    selectors: [
      '["highway"="bus_stop"]',
      '["railway"~"^(station|halt|tram_stop|subway_entrance)$"]',
      '["public_transport"="station"]',
    ],
  },
  { id: "park", label: "Parks", radiusM: 1500, selectors: ['["leisure"~"^(park|garden)$"]'] },
  { id: "money", label: "Banks and ATMs", radiusM: 2000, selectors: ['["amenity"~"^(atm|bank)$"]'] },
  { id: "hospital", label: "Hospitals", radiusM: 5000, selectors: ['["amenity"="hospital"]'] },
]);

const RULES = Object.freeze({
  topN: 5, // places kept per category
  maxElements: 300, // asked of Overpass per category
  freshMs: 7 * 24 * HOUR_MS, // data this young is not fetched again at publish
  manualCooldownMs: 24 * HOUR_MS, // a host may refresh once a day
  attemptThrottleMs: 5 * MINUTE_MS, // never two attempts closer than this
  retryBackoffMs: [15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS], // after failure 1, 2, 3+
  requestTimeoutMs: 25 * 1000, // our side; the query itself says [timeout:20]
  retryPauseMs: 2000, // before the one retry of a request
  maxRetryAfterMs: 10 * 1000,
});

const isOff = (value) => /^(false|0|no|off)$/i.test(String(value || "").trim());

/** @param {object} [env] process.env by default */
function readNearbyConfig(env = process.env) {
  const flag = typeof env.NEARBY_ENABLED === "string" ? env.NEARBY_ENABLED.trim() : "";
  // Off by default in tests so no test can reach the network by accident.
  const enabled = flag ? !isOff(flag) : env.NODE_ENV !== "test";

  const endpoint = (env.OVERPASS_URL || "").trim() || DEFAULT_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("OVERPASS_URL must be a full https:// address");
  }
  if (parsed.protocol !== "https:" && env.NODE_ENV === "production") {
    throw new Error("OVERPASS_URL must use https:// in production");
  }

  const contact = (env.NEARBY_CONTACT || env.APP_BASE_URL || "").trim();
  return Object.freeze({
    enabled,
    endpoint,
    userAgent: `Dimora-nearby/1.0 (+${contact || "no contact configured; set NEARBY_CONTACT"})`,
    contact,
  });
}

module.exports = { SOURCE, DEFAULT_ENDPOINT, CATEGORIES, RULES, readNearbyConfig };
