// Pricing (P08-T01): the one place that turns a listing's prices and a stay into
// an amount to pay (ADR-002). A pure function of its inputs: no database, no
// clock, no network, no floating point. Rounding is half up to the paisa, in
// src/utils/money.js. Rates and fees come from src/config/pricing.js.
//
// quote() returns
//   lines            what makes up the total, in display order; each line has a
//                    `code` ("nights", "weekend_nights", "cleaning",
//                    "service_fee", "tax") and `amountMinor`; the view writes the
//                    words. A line with `included: true` is shown but already
//                    inside the other amounts (tax in an inclusive price).
//   nights, subtotalMinor (the nights), cleaningMinor, serviceFeeMinor,
//   taxMinor, totalMinor, avgPerNightMinor, currency, taxMode, taxIncluded
//   breakdownVersion for stored snapshots (bump it when the shape changes)
// Always: totalMinor === the sum of the lines that are not `included` (the
// length discount line is negative).
//
// PRICE RULES (P08-T04), in the order they apply. Each shows as its own line.
//   1. Per night: a seasonal rate whose dates cover the night replaces the base
//      nightly price (seasons may not overlap; if stored data overlaps anyway,
//      the one that starts first wins). Lines: `season_nights` /
//      `season_weekend_nights`, with `label` (the season's name) and a `key`.
//   2. Weekend nights (config.weekendDays, the night that STARTS Friday or
//      Saturday): when the listing has a weekend markup (`pricing.weekendBps`),
//      the night costs the price from step 1 plus that percentage, in a season
//      too. Without a markup, a legacy absolute `pricing.weekendNightlyMinor`
//      applies to non-seasonal nights only. Lines: `weekend_nights`.
//   3. Length discount: a stay of 28+ nights gets the monthly percentage, of 7+
//      the weekly one; only the larger that applies, never both. It is taken
//      from the nights (steps 1 and 2) and never from the cleaning fee. Line:
//      `length_discount` (negative).
//   4. Cleaning fee, then service fee and tax on (nights - discount + cleaning);
//      the tax slab uses the average night price after the discount.
const defaultConfig = require("../config/pricing");
const {
  percentOf,
  divideRound,
  multiplyMinor,
  sumMinor,
  mulDivRound,
  MAX_BPS,
} = require("../utils/money");
const { eachNight, parseDateOnly } = require("../utils/dates");
const { ValidationError, QuoteRefusedError } = require("../utils/errors");

// Additive changes (new line codes, optional fields) keep version 1: an older
// stored snapshot is still read correctly.
const BREAKDOWN_VERSION = 1;
const MAX_DISCOUNT_BPS = 5000; // 50 %
const DEFAULT_WEEKLY_NIGHTS = 7;
const DEFAULT_MONTHLY_NIGHTS = 28;
const TAX_MODES = ["exclusive", "inclusive"];

const NO_PRICE =
  "This listing does not have a valid nightly price, so it cannot be booked yet.";

const isMinor = (value) => Number.isSafeInteger(value) && value >= 0;

function read(listing, path) {
  if (!listing || typeof listing !== "object") return undefined;
  if (typeof listing.get === "function") return listing.get(path);
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), listing);
}

/** Programming errors in the configuration are TypeErrors (a 500), never user messages. */
function assertConfig(config) {
  const bad = (what) => {
    throw new TypeError(`pricing config: ${what}`);
  };
  if (!config || typeof config !== "object") bad("missing");
  if (!/^[A-Z]{3}$/.test(config.currency)) bad("currency must be a 3-letter code");
  if (!Number.isInteger(config.serviceFeeBps) || config.serviceFeeBps < 0 || config.serviceFeeBps > MAX_BPS) {
    bad("serviceFeeBps must be an integer from 0 to 10000");
  }
  if (!TAX_MODES.includes(config.taxMode)) bad("taxMode must be exclusive or inclusive");
  if (!Array.isArray(config.taxSlabs) || config.taxSlabs.length === 0) bad("taxSlabs must be a non-empty list");
  let previous = -1;
  config.taxSlabs.forEach((slab, index) => {
    const last = index === config.taxSlabs.length - 1;
    if (!Number.isInteger(slab.rateBps) || slab.rateBps < 0 || slab.rateBps > MAX_BPS) {
      bad("each slab needs a rateBps from 0 to 10000");
    }
    if (slab.upToMinor === null) {
      if (!last) bad("only the last slab may have no upper limit");
    } else if (!isMinor(slab.upToMinor) || slab.upToMinor <= previous) {
      bad("slab limits must be increasing integers");
    } else {
      previous = slab.upToMinor;
    }
    if (last && slab.upToMinor !== null) bad("the last slab must have upToMinor: null");
  });
  if (
    !Array.isArray(config.weekendDays) ||
    config.weekendDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    bad("weekendDays must be a list of days 0-6");
  }
}

function priceOf(listing, config) {
  const nightly = read(listing, "pricing.nightlyMinor");
  if (!Number.isSafeInteger(nightly) || nightly < 1) throw new QuoteRefusedError(NO_PRICE);

  const weekendValue = read(listing, "pricing.weekendNightlyMinor");
  const hasWeekend = weekendValue !== undefined && weekendValue !== null;
  if (hasWeekend && (!Number.isSafeInteger(weekendValue) || weekendValue < 1)) {
    throw new QuoteRefusedError(NO_PRICE);
  }

  const cleaningValue = read(listing, "pricing.cleaningFeeMinor");
  const hasCleaning = cleaningValue !== undefined && cleaningValue !== null;
  if (hasCleaning && !isMinor(cleaningValue)) {
    throw new QuoteRefusedError("This listing has an invalid cleaning fee, so it cannot be booked yet.");
  }

  const currency = read(listing, "pricing.currency") ?? config.currency;
  if (currency !== config.currency) {
    throw new QuoteRefusedError("This listing's currency is not supported yet.");
  }

  return {
    nightly,
    weekend: hasWeekend ? weekendValue : nightly,
    cleaning: hasCleaning ? cleaningValue : 0,
    currency,
    ...rulesOf(listing),
  };
}

const BAD_RULES = "This listing has invalid price rules, so it cannot be booked yet.";

/** The optional rules (P08-T04); anything unreadable refuses the quote rather than guessing. */
function rulesOf(listing) {
  const optionalBps = (path, max) => {
    const value = read(listing, path);
    if (value === undefined || value === null) return 0;
    if (!Number.isInteger(value) || value < 0 || value > max) throw new QuoteRefusedError(BAD_RULES);
    return value;
  };
  const weekendBps = optionalBps("pricing.weekendBps", MAX_BPS);
  const weeklyBps = optionalBps("pricing.discounts.weeklyBps", MAX_DISCOUNT_BPS);
  const monthlyBps = optionalBps("pricing.discounts.monthlyBps", MAX_DISCOUNT_BPS);

  const raw = read(listing, "pricing.seasonalRates");
  const seasons = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    let from;
    let to;
    try {
      from = asDate(entry && entry.from, "Season start");
      to = asDate(entry && entry.to, "Season end");
    } catch {
      throw new QuoteRefusedError(BAD_RULES); // stored data, not user input
    }
    const nightly = entry && entry.nightlyMinor;
    if (
      !(from instanceof Date) ||
      !(to instanceof Date) ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to < from ||
      !Number.isSafeInteger(nightly) ||
      nightly < 1
    ) {
      throw new QuoteRefusedError(BAD_RULES);
    }
    seasons.push({ name: String((entry && entry.name) || "Season"), from, to, nightlyMinor: nightly });
  }
  seasons.sort((a, b) => a.from - b.from || a.to - b.to);
  return { weekendBps, weeklyBps, monthlyBps, seasons };
}

function asDate(value, label) {
  return typeof value === "string" ? parseDateOnly(value, label) : value;
}

function taxRateFor(averageMinor, slabs) {
  const slab = slabs.find((s) => s.upToMinor === null || averageMinor <= s.upToMinor);
  return slab.rateBps;
}

/**
 * @param {object} input
 * @param {object} input.listing    a listing document or plain object (reads `pricing.*`)
 * @param {Date|string} input.checkIn   date-only Date, or "YYYY-MM-DD"
 * @param {Date|string} input.checkOut  date-only Date (not charged), or "YYYY-MM-DD"
 * @param {number} input.guests     whole number, 1 or more (no price depends on it yet)
 * @param {object} [options]
 * @param {object} [options.config] defaults to src/config/pricing.js (tests pass their own)
 * @throws {ValidationError}  bad dates, a stay over 90 nights, bad guests
 * @throws {QuoteRefusedError} the listing has no usable price
 */
function quote({ listing, checkIn, checkOut, guests } = {}, { config = defaultConfig } = {}) {
  assertConfig(config);
  const nights = eachNight(asDate(checkIn, "Check-in"), asDate(checkOut, "Check-out"));
  if (!Number.isInteger(guests) || guests < 1) {
    throw new ValidationError("Guests must be a whole number of at least 1.");
  }
  const price = priceOf(listing, config);

  // Steps 1 and 2: the price of every night, then one line per distinct group.
  const seasonOf = (night) => price.seasons.findIndex((x) => night >= x.from && night <= x.to);
  const groups = new Map(); // key -> {season index or -1, weekend, unit, quantity}
  for (const night of nights) {
    const index = seasonOf(night);
    const base = index === -1 ? price.nightly : price.seasons[index].nightlyMinor;
    const weekend = config.weekendDays.includes(night.getUTCDay());
    let unit = base;
    if (weekend) {
      if (price.weekendBps > 0) unit = base + percentOf(base, price.weekendBps);
      else if (index === -1) unit = price.weekend;
    }
    const key = `${index}:${weekend ? "we" : "wd"}`;
    const group = groups.get(key) || { index, weekend, unit, quantity: 0 };
    group.quantity += 1;
    groups.set(key, group);
  }
  // Base lines first (weekdays, weekends), then each season in date order.
  const ordered = [...groups.values()].sort(
    (a, b) => a.index - b.index || Number(a.weekend) - Number(b.weekend),
  );

  const lines = [];
  for (const group of ordered) {
    const line = {
      code: group.index === -1 ? (group.weekend ? "weekend_nights" : "nights") : group.weekend ? "season_weekend_nights" : "season_nights",
      quantity: group.quantity,
      unitMinor: group.unit,
      amountMinor: multiplyMinor(group.unit, group.quantity),
    };
    if (group.index !== -1) {
      line.key = `season_${group.index + 1}_${group.weekend ? "weekend" : "weekday"}`;
      line.label = price.seasons[group.index].name;
    }
    lines.push(line);
  }
  const subtotalMinor = sumMinor(lines.map((line) => line.amountMinor));

  // Step 3: the larger of the length discounts that apply, never both.
  const weeklyFrom = config.weeklyNights ?? DEFAULT_WEEKLY_NIGHTS;
  const monthlyFrom = config.monthlyNights ?? DEFAULT_MONTHLY_NIGHTS;
  const monthly = nights.length >= monthlyFrom ? price.monthlyBps : 0;
  const weekly = nights.length >= weeklyFrom ? price.weeklyBps : 0;
  const discountBps = Math.max(monthly, weekly);
  const discountMinor = discountBps > 0 ? percentOf(subtotalMinor, discountBps) : 0;
  if (discountMinor > 0) {
    lines.push({
      code: "length_discount",
      kind: monthly >= weekly ? "monthly" : "weekly",
      rateBps: discountBps,
      baseMinor: subtotalMinor,
      amountMinor: -discountMinor,
    });
  }
  const discountedMinor = subtotalMinor - discountMinor;
  const avgPerNightMinor = divideRound(discountedMinor, nights.length);

  const cleaningMinor = price.cleaning;
  if (cleaningMinor > 0) lines.push({ code: "cleaning", amountMinor: cleaningMinor });

  const accommodationMinor = sumMinor([discountedMinor, cleaningMinor]);
  const serviceFeeMinor = percentOf(accommodationMinor, config.serviceFeeBps);
  if (serviceFeeMinor > 0) {
    lines.push({
      code: "service_fee",
      rateBps: config.serviceFeeBps,
      baseMinor: accommodationMinor,
      amountMinor: serviceFeeMinor,
    });
  }

  const rateBps = taxRateFor(avgPerNightMinor, config.taxSlabs);
  const taxIncluded = config.taxMode === "inclusive";
  // Exclusive: tax on top. Inclusive: the part of the price that is tax.
  const taxMinor = taxIncluded
    ? accommodationMinor - mulDivRound(accommodationMinor, MAX_BPS, MAX_BPS + rateBps)
    : percentOf(accommodationMinor, rateBps);
  if (taxMinor > 0) {
    const line = { code: "tax", rateBps, baseMinor: accommodationMinor, amountMinor: taxMinor };
    if (taxIncluded) line.included = true;
    lines.push(line);
  }

  // The discount line is negative, so it is taken off after adding the others.
  const totalMinor =
    sumMinor(lines.filter((line) => !line.included && line.amountMinor >= 0).map((line) => line.amountMinor)) -
    discountMinor;

  return {
    lines,
    nights: nights.length,
    subtotalMinor,
    ...(discountMinor > 0 ? { discountMinor } : {}),
    cleaningMinor,
    serviceFeeMinor,
    taxMinor,
    totalMinor,
    avgPerNightMinor,
    currency: price.currency,
    taxMode: config.taxMode,
    taxIncluded,
    breakdownVersion: BREAKDOWN_VERSION,
  };
}

module.exports = { quote, BREAKDOWN_VERSION, assertConfig, MAX_DISCOUNT_BPS };
