// The retry job for nearby places (P15-T01): every few minutes, listings whose
// last fetch failed and whose `nearby.nextRetryAt` has passed are tried again,
// a few at a time (each refresh is 7 Overpass queries, one after another).
const { refreshListing } = require("./nearby");
const { readNearbyConfig } = require("../config/nearby");

const MINUTE_MS = 60 * 1000;

async function runRetryPass({
  Listing = require("../models/listing"),
  refresh = refreshListing,
  now = new Date(),
  limit = 3,
  deps = {},
} = {}) {
  const due = await Listing.find({
    status: "published",
    deletedAt: null,
    "nearby.nextRetryAt": { $lte: now },
  })
    .sort({ "nearby.nextRetryAt": 1 })
    .limit(limit)
    .lean();
  const summary = { tried: 0, updated: 0, failed: 0 };
  for (const listing of due) {
    summary.tried += 1;
    const result = await refresh(listing, { manual: false, now, deps });
    if (result.status === "updated") summary.updated += 1;
    if (result.status === "failed") summary.failed += 1;
  }
  return summary;
}

/** Starts the job; returns a stop function. Does nothing when nearby places are off. */
function startNearbyRetry({ intervalMs = 5 * MINUTE_MS, logger, config } = {}) {
  const cfg = config || readNearbyConfig();
  if (!cfg.enabled) return () => {};
  const log = logger || { info() {}, warn() {} };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runRetryPass({ deps: { log, config: cfg } });
      if (summary.tried) log.info(summary, "nearby retry pass");
    } catch (err) {
      log.warn({ err: err && err.message }, "nearby retry pass failed");
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { runRetryPass, startNearbyRetry };
