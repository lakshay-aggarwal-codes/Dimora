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
// Always: totalMinor === the sum of the lines that are not `included`.
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

const BREAKDOWN_VERSION = 1;
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
  };
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

  const weekendNights = nights.filter((night) => config.weekendDays.includes(night.getUTCDay())).length;
  const weekdayNights = nights.length - weekendNights;

  const lines = [];
  if (weekdayNights > 0) {
    lines.push({
      code: "nights",
      quantity: weekdayNights,
      unitMinor: price.nightly,
      amountMinor: multiplyMinor(price.nightly, weekdayNights),
    });
  }
  if (weekendNights > 0) {
    lines.push({
      code: "weekend_nights",
      quantity: weekendNights,
      unitMinor: price.weekend,
      amountMinor: multiplyMinor(price.weekend, weekendNights),
    });
  }
  const subtotalMinor = sumMinor(lines.map((line) => line.amountMinor));
  const avgPerNightMinor = divideRound(subtotalMinor, nights.length);

  const cleaningMinor = price.cleaning;
  if (cleaningMinor > 0) lines.push({ code: "cleaning", amountMinor: cleaningMinor });

  const accommodationMinor = sumMinor([subtotalMinor, cleaningMinor]);
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

  const totalMinor = sumMinor(lines.filter((line) => !line.included).map((line) => line.amountMinor));

  return {
    lines,
    nights: nights.length,
    subtotalMinor,
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

module.exports = { quote, BREAKDOWN_VERSION, assertConfig };
