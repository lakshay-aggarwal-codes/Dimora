// The quote the booking panel shows (P08-T02). It never prices anything
// itself: the amounts are exactly what services/pricing.js returns, the same
// call reservations.create makes, so the number a guest sees is the number
// that is stored (Signature #1). The rules and the taken nights are checked
// first; a stay that cannot be booked gets its reasons and no price.
//
//   getQuote(listing, query, { now, ledgerService, pricingService, alternatives })
//   -> { in, out, guests, bookable, problems: [{code, message}],
//        quote: <pricing.quote output> | null, expectedTotalMinor | null,
//        alternatives?: { radiusDays, windows: [{ in, out, nights, shiftDays, quote }] } }
//
// With `alternatives: true` and the nights taken, the answer also carries the
// nearest free stays of the same length (services/flexibleDates.js, P15-T04).
//
// Reasons for unavailable nights are dates only: a block, a reservation and a
// live hold read the same (no guest or host information leaves the server).
const ledger = require("./ledger");
const pricing = require("./pricing");
const { bookingProblems } = require("./bookingRules");
const { parseQuoteQuery } = require("../validation/quoteQuery");
const { formatDateOnly } = require("../utils/dates");

async function getQuote(
  listing,
  query,
  {
    now = new Date(),
    ledgerService = ledger,
    pricingService = pricing,
    alternatives = false,
  } = {},
) {
  const { checkIn, checkOut, guests } = parseQuoteQuery(query);
  const base = {
    in: formatDateOnly(checkIn),
    out: formatDateOnly(checkOut),
    guests,
  };

  const problems = bookingProblems({ listing, checkIn, checkOut, guests, now });
  // Only a stay the rules accept is looked up in the ledger (its span is then
  // at most 90 nights).
  if (problems.length === 0) {
    const taken = await ledgerService.unavailableDates(
      listing._id,
      checkIn,
      checkOut,
      { now },
    );
    if (taken.length > 0) {
      problems.push({
        code: "nights_unavailable",
        message: `These nights are not available: ${taken.map(formatDateOnly).join(", ")}.`,
      });
    }
  }
  if (problems.length > 0) {
    const answer = {
      ...base,
      bookable: false,
      problems,
      quote: null,
      expectedTotalMinor: null,
    };
    if (alternatives && problems.some((p) => p.code === "nights_unavailable")) {
      // Loaded here, not at the top: flexibleDates asks this service for prices.
      const { suggestAlternatives } = require("./flexibleDates");
      answer.alternatives = await suggestAlternatives(
        listing,
        { checkIn, checkOut, guests },
        { now, ledgerService, pricingService },
      );
    }
    return answer;
  }
  // QuoteRefusedError (422) when the listing has no valid price.
  const quote = pricingService.quote({ listing, checkIn, checkOut, guests });
  return {
    ...base,
    bookable: true,
    problems: [],
    quote,
    expectedTotalMinor: quote.totalMinor,
  };
}

module.exports = { getQuote };
