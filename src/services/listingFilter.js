// The Mongo filter for the listings page URL (P05-T02), shared by the page and
// the map data (P06-T04) so both always show the same stays: validated
// parameters -> search filter, minus the listings with a taken night in the
// requested stay (the night ledger).
const ledger = require("./ledger");
const { buildFilter } = require("./search");
const { parseListingQuery } = require("../validation/searchQuery");
const { DEFAULT_TIMEZONE, todayIn } = require("../utils/dates");

/**
 * @param {object} query req.query
 * @returns {Promise<{ parsed: object, filter: object, takenIds: Array }>}
 */
async function listingFilterFor(query, { now = new Date() } = {}) {
  const parsed = parseListingQuery(query, { now });
  const filter = buildFilter(parsed.searchParams);
  let takenIds = [];
  if (parsed.stay) {
    // With "Available +-3 days" a listing stays if ANY same-length stay
    // starting within 3 days of the asked check-in is free (never before today).
    const taken = parsed.stay.flexDays
      ? await ledger.unavailableListingIdsFlexible(
          parsed.stay.checkIn,
          parsed.stay.checkOut,
          parsed.stay.flexDays,
          { now, earliest: todayIn(DEFAULT_TIMEZONE, now) },
        )
      : await ledger.unavailableListingIds(
          parsed.stay.checkIn,
          parsed.stay.checkOut,
          { now },
        );
    takenIds = taken;
    if (taken.length > 0) filter._id = { $nin: taken };
  }
  return { parsed, filter, takenIds };
}

module.exports = { listingFilterFor };
