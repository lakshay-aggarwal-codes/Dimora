// Nearby places for a listing (P15-T01), from OpenStreetMap through the
// Overpass API. This is the ONLY code that calls Overpass, and it is reached
// only from: publishing a listing, a host's refresh button, the retry job and
// scripts/refresh-nearby.js. Guests and visitors only ever read what is stored
// in `listing.nearby` (a test checks that no public code imports this file).
//
// Privacy: the search is centred on the listing's PRECISE point, which never
// leaves the server. Every stored distance is measured from the PUBLIC
// (approximate) point instead. Exact distances to several places with known
// positions would let anyone work the home's position out again.
//
// What is stored (listing.nearby):
//   fetchedAt, source, key (hash of the precise point the data is for),
//   items [{ category, name, kind, distanceM }] (top 5 per category, nearest first),
//   attemptedAt, failures, nextRetryAt (set while a fetch keeps failing).
// A failed fetch never erases earlier data.
const crypto = require("node:crypto");
const {
  SOURCE,
  CATEGORIES,
  RULES,
  readNearbyConfig,
} = require("../config/nearby");
const { distanceMeters, publicPointOf, toMapPoint } = require("../utils/geo");

class NearbyUnavailableError extends Error {
  constructor(message, { retryable = true, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "NearbyUnavailableError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---- small helpers --------------------------------------------------------

/** `date` moved by `ms` (no Date constructor with an argument; see noUserDate). */
function shift(date, ms) {
  const moved = new Date();
  moved.setTime(date.getTime() + ms);
  return moved;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same precise point -> same key; used to notice that the address moved. */
function keyFor(point) {
  return crypto
    .createHash("sha256")
    .update(`${point.lng.toFixed(5)},${point.lat.toFixed(5)}`)
    .digest("hex")
    .slice(0, 16);
}

// Control characters and bidi overrides can hide or reorder text.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Plain text, one line, at most 100 characters. HTML is NOT removed: every view escapes with <%= %>. */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return text || null;
}

function kindOf(tags) {
  const raw =
    tags.amenity || tags.shop || tags.leisure || tags.highway || tags.railway || tags.public_transport;
  return typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : null;
}

// ---- query and parser -----------------------------------------------------

/** Overpass QL for one category around the precise point. */
function buildQuery(point, category, { maxElements = RULES.maxElements } = {}) {
  const around = `(around:${category.radiusM},${point.lat.toFixed(6)},${point.lng.toFixed(6)})`;
  const parts = category.selectors.map((selector) => `  nwr${selector}${around};`);
  return [
    "[out:json][timeout:20][maxsize:33554432];",
    "(",
    ...parts,
    ");",
    `out center tags ${maxElements};`,
  ].join("\n");
}

/**
 * Overpass elements -> the top places of one category, nearest first.
 * @param {object[]} elements Overpass `elements`
 * @param {{id: string}} category
 * @param {{lng:number, lat:number}} origin where distances are measured from (the PUBLIC point)
 */
function parseElements(elements, category, origin, { topN = RULES.topN } = {}) {
  const found = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element !== "object") continue;
    const tags = element.tags && typeof element.tags === "object" ? element.tags : {};
    const lat = element.lat ?? (element.center && element.center.lat);
    const lng = element.lon ?? (element.center && element.center.lon);
    const place = toMapPoint({ type: "Point", coordinates: [lng, lat] });
    if (!place) continue;
    const name = cleanName(tags.name) || cleanName(tags["name:en"]);
    const kind = kindOf(tags);
    found.push({
      category: category.id,
      name,
      kind,
      // Rounded to 10 m: more precision would only pretend to be accurate.
      distanceM: Math.round(distanceMeters(origin, place) / 10) * 10,
    });
  }
  found.sort((a, b) => a.distanceM - b.distanceM || String(a.name).localeCompare(String(b.name)));

  // OpenStreetMap often has two entries for one place (a node and a building)
  // and chains repeat: keep the nearest of each name (or of each unnamed kind).
  const seen = new Set();
  const items = [];
  for (const item of found) {
    const key = item.name ? item.name.toLowerCase() : `(${item.kind})`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= topN) break;
  }
  return items;
}

// ---- Overpass client (one at a time, one retry) ---------------------------

let tail = Promise.resolve();
/** Global concurrency 1: tasks run strictly one after another in this process. */
function serial(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

async function requestOnce(query, { fetchImpl, config }) {
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(RULES.requestTimeoutMs),
    });
  } catch (err) {
    throw new NearbyUnavailableError(`Overpass did not answer (${err && err.name ? err.name : "error"})`);
  }
  if (response.status === 429 || response.status >= 500) {
    const seconds = Number(response.headers && response.headers.get && response.headers.get("retry-after"));
    throw new NearbyUnavailableError(`Overpass is busy or down (HTTP ${response.status})`, {
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    });
  }
  if (!response.ok) {
    throw new NearbyUnavailableError(`Overpass refused the query (HTTP ${response.status})`, { retryable: false });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new NearbyUnavailableError("Overpass sent something that is not JSON");
  }
  // A query that ran out of time or memory can still answer 200, with a remark.
  if (body && typeof body.remark === "string" && /runtime error|timed out|out of memory/i.test(body.remark)) {
    throw new NearbyUnavailableError("Overpass could not finish the query in time");
  }
  if (!body || !Array.isArray(body.elements)) {
    throw new NearbyUnavailableError("Overpass sent an unexpected answer", { retryable: false });
  }
  return body.elements;
}

/** One request, with exactly one retry after a pause (Retry-After if given, capped). */
async function overpass(query, { fetchImpl, config, sleep }) {
  try {
    return await requestOnce(query, { fetchImpl, config });
  } catch (err) {
    if (!(err instanceof NearbyUnavailableError) || !err.retryable) throw err;
    await sleep(Math.min(err.retryAfterMs || RULES.retryPauseMs, RULES.maxRetryAfterMs));
    return requestOnce(query, { fetchImpl, config });
  }
}

// ---- when may we fetch? ---------------------------------------------------

/**
 * @returns {{ ok: true } | { ok: false, reason: "fresh"|"cooldown"|"throttled", retryAt: Date|null }}
 */
function mayFetch(stored, key, { manual, now }) {
  const n = stored || {};
  const sameSpot = n.key === key;
  if (n.attemptedAt && now.getTime() - n.attemptedAt.getTime() < RULES.attemptThrottleMs) {
    return { ok: false, reason: "throttled", retryAt: shift(n.attemptedAt, RULES.attemptThrottleMs) };
  }
  if (n.fetchedAt && sameSpot) {
    const age = now.getTime() - n.fetchedAt.getTime();
    if (manual && age < RULES.manualCooldownMs) {
      return { ok: false, reason: "cooldown", retryAt: shift(n.fetchedAt, RULES.manualCooldownMs) };
    }
    if (!manual && age < RULES.freshMs) {
      return { ok: false, reason: "fresh", retryAt: shift(n.fetchedAt, RULES.freshMs) };
    }
  }
  return { ok: true };
}

/** For the host button: can this listing be refreshed now? (no network, no writes) */
function manualVerdict(listing, { now = new Date(), config = readNearbyConfig() } = {}) {
  if (!config.enabled) return { ok: false, reason: "disabled", retryAt: null };
  const precise = toMapPoint(listing && listing.geometry);
  if (!precise) return { ok: false, reason: "no_location", retryAt: null };
  return mayFetch(listing.nearby, keyFor(precise), { manual: true, now });
}

// ---- the refresh ----------------------------------------------------------

function loadListingModel(deps) {
  return deps.Listing || require("../models/listing");
}

/**
 * Fetches and stores the nearby places of one published listing.
 * Never throws for an Overpass problem: it reports `failed` and schedules a retry.
 * @returns {Promise<{status: "disabled"|"skipped"|"no_location"|"fresh"|"cooldown"|"throttled"|"updated"|"failed", ...}>}
 */
async function refreshListing(listing, { manual = false, now = new Date(), deps = {} } = {}) {
  const config = deps.config || readNearbyConfig();
  if (!config.enabled) return { status: "disabled" };
  if (!listing || listing.status !== "published" || listing.deletedAt) return { status: "skipped" };

  const precise = toMapPoint(listing.geometry);
  const origin = precise && publicPointOf(listing);
  if (!precise || !origin) return { status: "no_location" };

  const key = keyFor(precise);
  const verdict = mayFetch(listing.nearby, key, { manual, now });
  if (!verdict.ok) return { status: verdict.reason, retryAt: verdict.retryAt };

  const Listing = loadListingModel(deps);
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || sleepFor;
  const log = deps.log || { info() {}, warn() {} };

  return serial(async () => {
    try {
      const items = [];
      for (const category of CATEGORIES) {
        const elements = await overpass(buildQuery(precise, category), { fetchImpl, config, sleep });
        items.push(...parseElements(elements, category, origin));
      }
      await Listing.updateOne(
        { _id: listing._id },
        {
          $set: {
            nearby: {
              fetchedAt: now,
              attemptedAt: now,
              source: SOURCE,
              key,
              items,
              failures: 0,
              nextRetryAt: null,
            },
          },
        },
      );
      log.info({ listingId: String(listing._id), places: items.length }, "nearby places updated");
      return { status: "updated", count: items.length };
    } catch (err) {
      if (!(err instanceof NearbyUnavailableError)) throw err;
      const failures = ((listing.nearby && listing.nearby.failures) || 0) + 1;
      const wait = RULES.retryBackoffMs[Math.min(failures - 1, RULES.retryBackoffMs.length - 1)];
      const nextRetryAt = shift(now, wait);
      // Dot paths: whatever was stored before stays.
      await Listing.updateOne(
        { _id: listing._id },
        { $set: { "nearby.attemptedAt": now, "nearby.failures": failures, "nearby.nextRetryAt": nextRetryAt } },
      );
      log.warn({ listingId: String(listing._id), failures, reason: err.message }, "nearby places not updated");
      return { status: "failed", failures, nextRetryAt, reason: err.message };
    }
  });
}

/**
 * Fire and forget: loads the listing and refreshes it in the background so a
 * slow Overpass never delays publishing. Every error is logged, none escapes.
 */
function scheduleRefresh(listingId, { manual = false, deps = {} } = {}) {
  let config;
  try {
    config = deps.config || readNearbyConfig();
  } catch (err) {
    if (deps.log) deps.log.warn({ err: err.message }, "nearby places not configured");
    return;
  }
  if (!config.enabled) return;
  const log = deps.log || { info() {}, warn() {} };
  setImmediate(async () => {
    try {
      const listing = await loadListingModel(deps).findById(listingId).lean();
      await refreshListing(listing, { manual, deps: { ...deps, config } });
    } catch (err) {
      log.warn({ listingId: String(listingId), err: err && err.message }, "nearby refresh crashed");
    }
  });
}

// ---- what the host page shows --------------------------------------------

/** Counts and names of what is stored, for the host's status page. No network. */
function summaryFor(listing, { now = new Date(), config } = {}) {
  const cfg = config || readNearbyConfig();
  const stored = (listing && listing.nearby) || {};
  const items = Array.isArray(stored.items) ? stored.items : [];
  const verdict = manualVerdict(listing, { now, config: cfg });
  return {
    enabled: cfg.enabled,
    fetchedOn: stored.fetchedAt ? stored.fetchedAt.toISOString().slice(0, 10) : null,
    source: stored.source || SOURCE,
    failing: Boolean(stored.nextRetryAt) && (stored.failures || 0) > 0,
    total: items.length,
    categories: CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      items: items
        .filter((i) => i.category === c.id)
        .map((i) => ({ name: i.name, kind: i.kind, distanceM: i.distanceM })),
    })),
    canRefresh: verdict.ok,
    retryOn: verdict.retryAt ? verdict.retryAt.toISOString().slice(0, 10) : null,
    refuseReason: verdict.ok ? null : verdict.reason,
  };
}

module.exports = {
  refreshListing,
  scheduleRefresh,
  manualVerdict,
  summaryFor,
  buildQuery,
  parseElements,
  cleanName,
  keyFor,
  mayFetch,
  NearbyUnavailableError,
  SOURCE,
};
