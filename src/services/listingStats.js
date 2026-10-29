// Host listing statistics (P13-T03). APPROXIMATE by design, and labelled so.
//
// Counting rules
//  - A view counts once per browser session per listing per day. The "seen"
//    marks live in the session (at most MAX_SEEN of them, old days dropped).
//  - Not counted: requests with no or a bot-like User-Agent (a heuristic, so
//    some bots get through and a few odd browsers do not), the listing's own
//    host, the host's "see it as a guest" preview, and listings that are not
//    public.
//  - Counting never breaks a page: every failure is caught and logged.
//  - Counters only go up with $inc (views, checkout starts, daily saves). The
//    lifetime ListingStat.saves can be driven down by un-saves, and is clamped
//    at 0 so it is never negative.
const { todayIn, addDays, formatDateOnly, DEFAULT_TIMEZONE } = require("../utils/dates");

const WINDOW_DAYS = 30;
const MIN_VIEWS_FOR_CONVERSION = 30;
const MAX_SEEN = 100;

// Words that show up in the User-Agent of crawlers, link previewers, monitors
// and scripts. A heuristic, not a guarantee.
const BOT_UA =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|monitor|uptime|pingdom|lighthouse|headless|phantomjs|puppeteer|playwright|curl|wget|httpclient|python|java\/|go-http|scrapy|axios|node-fetch|okhttp/i;

/** True for a missing, very short, or bot-like User-Agent. */
function isBot(userAgent) {
  if (typeof userAgent !== "string") return true;
  const ua = userAgent.trim();
  return ua.length < 10 || BOT_UA.test(ua);
}

const models = (deps = {}) => ({
  DayStat: deps.DayStat || require("../models/listingDayStat"),
  ListingStat: deps.ListingStat || require("../models/listingStat"),
  Reservation: deps.Reservation || require("../models/reservation"),
});

const dayOf = (now) => todayIn(DEFAULT_TIMEZONE, now);

/** $inc one counter of today's row, creating it. One retry when two requests create it at once. */
async function bump(listingId, field, { now = new Date(), deps } = {}) {
  const { DayStat } = models(deps);
  const filter = { listing: listingId, day: dayOf(now) };
  const update = { $inc: { [field]: 1 } };
  try {
    await DayStat.updateOne(filter, update, { upsert: true });
  } catch (err) {
    if (err && err.code === 11000) {
      await DayStat.updateOne(filter, update, { upsert: true });
      return;
    }
    throw err;
  }
}

/** True the first time this session sees `key` today; remembers it. */
function firstTimeToday(session, key, now) {
  if (!session || typeof session !== "object") return false;
  const today = formatDateOnly(dayOf(now));
  const seen = session.statSeen && typeof session.statSeen === "object" ? session.statSeen : {};
  const kept = {};
  for (const [k, day] of Object.entries(seen)) if (day === today) kept[k] = day;
  if (kept[key]) {
    session.statSeen = kept;
    return false;
  }
  const keys = Object.keys(kept);
  if (keys.length >= MAX_SEEN) delete kept[keys[0]];
  kept[key] = today;
  session.statSeen = kept;
  return true;
}

function shouldCount(req, listing, { preview = false } = {}) {
  if (!req || !listing || preview) return false;
  if (isBot(req.get && req.get("user-agent"))) return false;
  const owner = listing.owner && (listing.owner._id || listing.owner);
  if (req.user && owner && String(req.user._id) === String(owner)) return false;
  return true;
}

async function count(kind, req, listing, options = {}) {
  try {
    if (!shouldCount(req, listing, options)) return false;
    const now = options.now || new Date();
    const key = `${kind}:${listing._id}`;
    if (!firstTimeToday(req.session, key, now)) return false;
    await bump(listing._id, kind === "v" ? "views" : "checkoutStarts", { now, deps: options.deps });
    return true;
  } catch (err) {
    if (req && req.log) req.log.warn({ err }, "listing stat not counted");
    return false;
  }
}

/** A page view of a public listing. Never throws. */
const recordView = (req, listing, options) => count("v", req, listing, options);

/** A checkout page opened for a listing. Never throws. */
const recordCheckoutStart = (req, listing, options) => count("c", req, listing, options);

/** A stay was saved (a row was really created). Never throws. */
async function recordSave(listingId, { now, deps } = {}) {
  try {
    await bump(listingId, "saves", { now, deps });
  } catch (err) {
    // statistics must never break saving
  }
}

/** After an un-save: the lifetime total may not stay below zero. Never throws. */
async function clampSaves(listingId, { deps } = {}) {
  try {
    const { ListingStat } = models(deps);
    await ListingStat.updateOne({ listing: listingId, saves: { $lt: 0 } }, { $set: { saves: 0 } });
  } catch (err) {
    // see above
  }
}

/**
 * The last `days` days (today included) for one listing, oldest first, with
 * every day present (zeros where nothing was counted).
 * conversion = reservations created in the window / views in the window, only
 * when views >= 30 (below that a ratio says nothing); null otherwise.
 */
async function getStats(listingId, { now = new Date(), days = WINDOW_DAYS, deps } = {}) {
  const { DayStat, ListingStat, Reservation } = models(deps);
  const today = dayOf(now);
  const first = addDays(today, -(days - 1));
  const rows = await DayStat.find({ listing: listingId, day: { $gte: first, $lte: today } }).lean();
  const byDay = new Map(rows.map((r) => [formatDateOnly(r.day), r]));

  const series = [];
  const total = { views: 0, saves: 0, checkoutStarts: 0 };
  for (let i = 0; i < days; i += 1) {
    const day = addDays(first, i);
    const row = byDay.get(formatDateOnly(day)) || {};
    const point = {
      day: formatDateOnly(day),
      views: row.views || 0,
      saves: row.saves || 0,
      checkoutStarts: row.checkoutStarts || 0,
    };
    total.views += point.views;
    total.saves += point.saves;
    total.checkoutStarts += point.checkoutStarts;
    series.push(point);
  }

  const reservations = await Reservation.countDocuments({
    listing: listingId,
    createdAt: { $gte: first },
  });
  const lifetime = await ListingStat.findOne({ listing: listingId }).lean();
  const conversion =
    total.views >= MIN_VIEWS_FOR_CONVERSION
      ? Math.min(100, Math.round((reservations * 1000) / total.views) / 10)
      : null;

  return {
    days,
    from: formatDateOnly(first),
    to: formatDateOnly(today),
    series,
    total,
    reservations,
    conversion,
    minViewsForConversion: MIN_VIEWS_FOR_CONVERSION,
    savedNow: Math.max(0, (lifetime && lifetime.saves) || 0),
  };
}

module.exports = {
  isBot,
  recordView,
  recordCheckoutStart,
  recordSave,
  clampSaves,
  getStats,
  firstTimeToday,
  shouldCount,
  WINDOW_DAYS,
  MIN_VIEWS_FOR_CONVERSION,
  MAX_SEEN,
};
