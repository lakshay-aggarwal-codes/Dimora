// Flexible-date suggestions (P15-T04, signature #5): when the nights a guest
// asked for are taken, offer the nearest free stays of the SAME length.
//
//   suggestAlternatives(listing, { checkIn, checkOut, guests }, options)
//   -> { radiusDays, windows: [{ in, out, nights, shiftDays, quote }] }
//
// How it chooses (all of it is checked again at the moment of the answer):
// 1. availableRanges() gives the free stretches of the night ledger between
//    `radiusDays` (14) before the requested check-in and after the requested
//    check-out; an expired hold counts as free, a host block as taken.
// 2. Every start date that fits a free stretch is a candidate, nearest to the
//    requested check-in first (earlier first on a tie). Candidates are taken
//    greedily, skipping any that overlaps one already chosen, so three
//    suggestions are three different stays, not the same stay shifted by a day.
// 3. A candidate must pass the booking rules (minimum and maximum stay,
//    notice, cut-off, not in the past, capacity) and is priced by the quote
//    service itself, the same call the panel and the checkout make. A
//    candidate the quote service refuses is dropped, not shown.
// At most `max` (3) windows are returned; none is not an error.
//
// A suggestion can still be booked by someone else before the guest clicks it:
// that goes down the normal conflict path (a 409 at checkout).
const ledger = require("./ledger");
const pricing = require("./pricing");
const { bookingProblems } = require("./bookingRules");
const {
  DEFAULT_TIMEZONE,
  addDays,
  formatDateOnly,
  nightsBetween,
  todayIn,
} = require("../utils/dates");

const DEFAULTS = Object.freeze({ radiusDays: 14, max: 3 });
const MS_PER_DAY = 86400000;

const daysBetween = (a, b) =>
  Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);

/**
 * @param {object} listing the listing document (rules and prices)
 * @param {{ checkIn: Date, checkOut: Date, guests: number }} stay date-only Dates
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.radiusDays]
 * @param {number} [options.max]
 * @param {object} [options.ledgerService] needs availableRanges and unavailableDates
 * @param {object} [options.pricingService]
 * @param {Function} [options.getQuoteFn] replaceable in tests
 */
async function suggestAlternatives(
  listing,
  { checkIn, checkOut, guests },
  {
    now = new Date(),
    radiusDays = DEFAULTS.radiusDays,
    max = DEFAULTS.max,
    ledgerService = ledger,
    pricingService = pricing,
    getQuoteFn = (...args) => require("./quoteService").getQuote(...args),
  } = {},
) {
  const nights = nightsBetween(checkIn, checkOut);
  const today = todayIn((listing && listing.timezone) || DEFAULT_TIMEZONE, now);

  // Never look at nights before today: they could not be booked anyway.
  let from = addDays(checkIn, -radiusDays);
  if (from.getTime() < today.getTime()) from = today;
  const to = addDays(checkOut, radiusDays);
  if (from.getTime() >= to.getTime()) return { radiusDays, windows: [] };

  const free = await ledgerService.availableRanges(listing._id, from, to, {
    now,
  });

  const candidates = [];
  for (const range of free) {
    for (let k = 0; k + nights <= range.nights; k += 1) {
      const start = addDays(range.from, k);
      const shift = daysBetween(checkIn, start);
      if (shift === 0) continue; // the requested stay itself
      candidates.push({ start, end: addDays(start, nights), shift });
    }
  }
  candidates.sort(
    (a, b) => Math.abs(a.shift) - Math.abs(b.shift) || a.shift - b.shift,
  );

  const windows = [];
  for (const candidate of candidates) {
    if (windows.length >= max) break;
    const overlaps = windows.some(
      (w) =>
        candidate.start.getTime() < w.endDate.getTime() &&
        candidate.end.getTime() > w.startDate.getTime(),
    );
    if (overlaps) continue;
    // Cheap rule check first; the quote below repeats it with the ledger and price.
    if (
      bookingProblems({
        listing,
        checkIn: candidate.start,
        checkOut: candidate.end,
        guests,
        now,
      }).length
    )
      continue;
    const payload = await getQuoteFn(
      listing,
      {
        in: formatDateOnly(candidate.start),
        out: formatDateOnly(candidate.end),
        guests: String(guests),
      },
      { now, ledgerService, pricingService },
    );
    if (!payload.bookable) continue;
    windows.push({
      in: payload.in,
      out: payload.out,
      nights,
      shiftDays: candidate.shift,
      quote: payload.quote,
      startDate: candidate.start,
      endDate: candidate.end,
    });
  }
  return {
    radiusDays,
    windows: windows.map(({ startDate, endDate, ...rest }) => rest), // eslint-disable-line no-unused-vars
  };
}

module.exports = { suggestAlternatives, DEFAULTS };
