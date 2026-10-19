// Public availability of one listing (P07-T04): which nights a guest cannot
// book, plus the stay rules the date picker enforces. Dates only: never who
// holds a night or why (a reservation, a pending request and a host block look
// the same), so the answer is safe to show to anybody.
//
//   parseAvailabilityQuery(query, { today }) -> { from, to }   (400 on bad input)
//   stayRulesFor(listing, { today })         -> the picker's rules
//   getAvailability(listing, query, deps)    -> JSON-ready payload
const ledger = require("./ledger");
const {
  BOOKING_WINDOW,
  DEFAULT_TIMEZONE,
  tryParseDateOnly,
  formatDateOnly,
  addDays,
  isBefore,
  isAfter,
  todayIn,
  bookingWindow,
} = require("../utils/dates");
const { ValidationError } = require("../utils/errors");

// Same cap as the ledger's own range limit.
const MAX_RANGE_NIGHTS = 400;

function readDate(query, name) {
  const raw = query ? query[name] : undefined;
  if (raw === undefined || raw === "") {
    throw new ValidationError(`"${name}" is required (YYYY-MM-DD).`);
  }
  // A repeated parameter (?from=a&from=b) or from[x]=y is not a string.
  const date = typeof raw === "string" ? tryParseDateOnly(raw) : null;
  if (!date) {
    throw new ValidationError(`"${name}" must be a valid date in YYYY-MM-DD format.`);
  }
  return date;
}

/**
 * `from` is included, `to` is not (the same convention as a check-in/check-out
 * pair). Both are required real calendar dates, `to` after `from`, at most
 * 400 nights apart.
 */
function parseAvailabilityQuery(query) {
  const from = readDate(query, "from");
  const to = readDate(query, "to");
  if (!isAfter(to, from)) {
    throw new ValidationError('"to" must be after "from".');
  }
  if ((to.getTime() - from.getTime()) / 86400000 > MAX_RANGE_NIGHTS) {
    throw new ValidationError(
      `The range can cover at most ${MAX_RANGE_NIGHTS} nights.`,
    );
  }
  return { from, to };
}

/** What the picker enforces: today, last check-in, and the stay length. */
function stayRulesFor(listing, { today }) {
  const { earliestCheckIn, latestCheckIn } = bookingWindow(today);
  const hostMin = Number.isInteger(listing && listing.minNights) ? listing.minNights : 1;
  const hostMax = Number.isInteger(listing && listing.maxNights)
    ? listing.maxNights
    : BOOKING_WINDOW.MAX_STAY_NIGHTS;
  const maxNights = Math.min(hostMax, BOOKING_WINDOW.MAX_STAY_NIGHTS);
  const minNights = Math.min(Math.max(hostMin, 1), maxNights);
  return {
    today: formatDateOnly(today),
    earliestCheckIn: formatDateOnly(earliestCheckIn),
    latestCheckIn: formatDateOnly(latestCheckIn),
    minNights,
    maxNights,
  };
}

/**
 * Re-checks a stay on the server (the picker only helps the guest; this is
 * the rule). Returns the list of problems, empty when the stay is acceptable.
 * `unavailable` is an array of date-only Dates (see ledger.unavailableDates).
 */
function stayProblems({ checkIn, checkOut, rules, unavailable = [] }) {
  const problems = [];
  if (!isAfter(checkOut, checkIn)) {
    return ["Check-out must be after check-in."];
  }
  const nights = (checkOut.getTime() - checkIn.getTime()) / 86400000;
  const today = tryParseDateOnly(rules.today);
  const latest = tryParseDateOnly(rules.latestCheckIn);
  if (isBefore(checkIn, today)) problems.push("Check-in cannot be in the past.");
  if (isAfter(checkIn, latest)) {
    problems.push(`Check-in can be at most ${BOOKING_WINDOW.MAX_HORIZON_DAYS} days ahead.`);
  }
  if (nights < rules.minNights) {
    problems.push(`The minimum stay is ${rules.minNights} night${rules.minNights === 1 ? "" : "s"}.`);
  }
  if (nights > rules.maxNights) {
    problems.push(`The maximum stay is ${rules.maxNights} night${rules.maxNights === 1 ? "" : "s"}.`);
  }
  const taken = unavailable
    .filter((d) => !isBefore(d, checkIn) && isBefore(d, checkOut))
    .map(formatDateOnly);
  if (taken.length) {
    problems.push(`These nights are not available: ${taken.join(", ")}.`);
  }
  return problems;
}

/**
 * @param {object} listing  needs minNights and maxNights
 * @param {object} query    req.query (strings only are accepted)
 * @param {object} [deps]
 */
async function getAvailability(
  listing,
  query,
  { now = new Date(), ledgerService = ledger, timeZone = DEFAULT_TIMEZONE } = {},
) {
  const { from, to } = parseAvailabilityQuery(query);
  const today = todayIn(timeZone, now);
  const rules = stayRulesFor(listing, { today });

  // Nights before today are not bookable anyway and nights beyond the last
  // possible stay are not worth a query: ask only for what can matter.
  const lastNight = addDays(
    tryParseDateOnly(rules.latestCheckIn),
    BOOKING_WINDOW.MAX_STAY_NIGHTS,
  );
  const askFrom = isBefore(from, today) ? today : from;
  const askTo = isAfter(to, lastNight) ? lastNight : to;

  let unavailable = [];
  if (isBefore(askFrom, askTo)) {
    unavailable = await ledgerService.unavailableDates(listing._id, askFrom, askTo, { now });
  }
  return {
    from: formatDateOnly(from),
    to: formatDateOnly(to),
    unavailable: unavailable.map(formatDateOnly),
    rules,
  };
}

module.exports = {
  MAX_RANGE_NIGHTS,
  parseAvailabilityQuery,
  stayRulesFor,
  stayProblems,
  getAvailability,
};
