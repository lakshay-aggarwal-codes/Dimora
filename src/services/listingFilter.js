// The Mongo filter for the listings page URL (P05-T02), shared by the page and
// the map data (P06-T04) so both always show the same stays: validated
// parameters -> search filter, minus the listings with a taken night in the
// requested stay (the night ledger).
const ledger = require("./ledger");
const { buildFilter } = require("./search");
const { areaCentre, areaCondition } = require("./area");
const { parseListingQuery } = require("../validation/searchQuery");
const { DEFAULT_TIMEZONE, todayIn } = require("../utils/dates");

/**
 * @param {object} query req.query
 * @returns {Promise<{ parsed: object, filter: object, takenIds: Array }>}
 */
async function listingFilterFor(query, { now = new Date(), Listing = require("../models/listing") } = {}) {
  const parsed = parseListingQuery(query, { now });
  let filter = buildFilter(parsed.searchParams);
  // "Within N km of the destination" (P06-T05): the circle REPLACES the text
  // match, so nearby towns count. `parsed.area` is what the page and the
  // suggestions need; it stays null when the destination has no stays to centre on.
  parsed.area = null;
  if (parsed.state.radius && parsed.searchParams.destination) {
    const centre = await areaCentre(Listing, parsed.searchParams.destination);
    if (centre) {
      const { destination, ...rest } = parsed.searchParams;
      void destination;
      const condition = areaCondition(centre, parsed.state.radius);
      filter = { ...buildFilter(rest), ...condition };
      parsed.area = { km: parsed.state.radius, centre, condition };
    }
  }
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
