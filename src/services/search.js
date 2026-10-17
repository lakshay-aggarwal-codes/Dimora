// Search (P05-T01): turns validated parameters into a Mongo filter and runs it.
// Only listings a visitor may see are ever matched (published, not deleted).
//
//   destination  "Panaji, Goa": each comma-separated part must START the city,
//                state or country key (anchored, so an index can serve it)
//   keywords     words in the title or description (the text index)
//   minPrice / maxPrice   rupees per night
//   guests / bedrooms     at least this many
//   propertyType / roomType   any of
//   amenities    all of
//   instantBook  true = only instant-book listings
//
// Sorting, paging and the URL live in P05-T02/T03.
const { parseSearchParams } = require("../validation/search");
const { publicListingFilter } = require("../utils/visibility");
const { destinationParts, escapeRegex } = require("../utils/searchKeys");
const { rupeesToMinor } = require("../utils/listingFields");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

/**
 * The filter for already validated parameters (see parseSearchParams).
 * Values are only ever placed as plain strings, numbers, RegExps built from
 * escaped text, or arrays of strings, never as objects taken from the request.
 */
function buildFilter(params = {}) {
  const filter = { ...publicListingFilter() };

  const parts = destinationParts(params.destination);
  if (parts.length) {
    filter.$and = parts.map((part) => {
      const start = new RegExp(`^${escapeRegex(part)}`);
      return { $or: [{ cityKey: start }, { stateKey: start }, { countryKey: start }] };
    });
  }

  if (typeof params.keywords === "string" && params.keywords.trim()) {
    filter.$text = { $search: params.keywords.trim() };
  }

  const price = {};
  if (typeof params.minPrice === "number") price.$gte = rupeesToMinor(params.minPrice);
  if (typeof params.maxPrice === "number") price.$lte = rupeesToMinor(params.maxPrice);
  if (Object.keys(price).length) filter["pricing.nightlyMinor"] = price;

  if (Number.isInteger(params.guests)) filter["capacity.guests"] = { $gte: params.guests };
  if (Number.isInteger(params.bedrooms)) filter["capacity.bedrooms"] = { $gte: params.bedrooms };

  if (Array.isArray(params.propertyType) && params.propertyType.length) {
    filter.propertyType = { $in: params.propertyType };
  }
  if (Array.isArray(params.roomType) && params.roomType.length) {
    filter.roomType = { $in: params.roomType };
  }
  if (Array.isArray(params.amenities) && params.amenities.length) {
    filter.amenities = { $all: params.amenities };
  }
  if (params.instantBook === true) filter.instantBook = true;

  return filter;
}

/** Validates `query` and builds the filter in one step. */
function searchFilterFor(query) {
  const { value, errors } = parseSearchParams(query);
  return { params: value, errors, filter: buildFilter(value) };
}

/**
 * Runs a search. Newest first until P05-T03 adds sorting.
 * @returns {Promise<{ listings: object[], params: object, errors: object, filter: object }>}
 */
async function searchListings(Listing, query, { limit = DEFAULT_LIMIT, skip = 0 } = {}) {
  const { params, errors, filter } = searchFilterFor(query);
  const take = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const listings = await Listing.find(filter)
    .sort({ _id: -1 })
    .skip(Math.max(Number.isInteger(skip) ? skip : 0, 0))
    .limit(take);
  return { listings, params, errors, filter };
}

/** MongoDB's own account of how a search runs (used by the index check). */
async function explainSearch(Listing, query) {
  const { filter } = searchFilterFor(query);
  return Listing.find(filter).explain("executionStats");
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildFilter,
  searchFilterFor,
  searchListings,
  explainSearch,
};
