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
//   category     one slug from src/config/categories.js (P05-T04); added as one
//                more condition, so it narrows the other filters, never widens
//
// `sort` and `page` (P05-T03) are handled by searchPage below; the URL names and
// forms are P05-T02.
const { parseSearchParams, DEFAULT_SORT } = require("../validation/search");
const { publicListingFilter } = require("../utils/visibility");
const { destinationParts, escapeRegex } = require("../utils/searchKeys");
const { rupeesToMinor } = require("../utils/listingFields");
const { categoryClause } = require("../config/categories");

const PAGE_SIZE = 12;
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

  const category = categoryClause(params.category);
  if (category) filter.$and = [...(filter.$and || []), category];

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

/**
 * The Mongo sort for a sort name. Every order ends with `_id` in the same
 * direction, so two listings never tie and a listing never appears on two
 * pages (or none) while paging.
 *  relevance  text score (only when searching by keywords), then rating, then newest
 *  price_asc / price_desc   nightly price
 *  rating     average rating, then number of reviews
 *  newest     most recently created
 * @returns {{ sort: object, projection?: object }}
 */
function sortSpec(name, { hasText = false } = {}) {
  switch (name) {
    case "price_asc":
      return { sort: { "pricing.nightlyMinor": 1, _id: 1 } };
    case "price_desc":
      return { sort: { "pricing.nightlyMinor": -1, _id: -1 } };
    case "rating":
      return { sort: { ratingAvg: -1, ratingCount: -1, _id: -1 } };
    case "newest":
      return { sort: { createdAt: -1, _id: -1 } };
    default: // relevance
      return hasText
        ? {
            projection: { score: { $meta: "textScore" } },
            sort: { score: { $meta: "textScore" }, ratingAvg: -1, ratingCount: -1, _id: -1 },
          }
        : { sort: { ratingAvg: -1, ratingCount: -1, _id: -1 } };
  }
}

/**
 * One page of results with the numbers a results page needs.
 * @returns {Promise<{
 *   listings: object[], total: number, page: number, totalPages: number,
 *   pageSize: number, sort: string, outOfRange: boolean,
 *   params: object, errors: object, filter: object }>}
 * `outOfRange` is true when the page asked for is past the last one: then
 * `listings` is empty and `totalPages` says where the last page is.
 */
async function searchPage(Listing, query) {
  const { params, errors, filter } = searchFilterFor(query);
  const sort = params.sort || DEFAULT_SORT;
  const requested = Number.isInteger(params.page) ? params.page : 1;

  const total = await Listing.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base = { total, page: requested, totalPages, pageSize: PAGE_SIZE, sort, params, errors, filter };
  if (requested > totalPages) return { ...base, listings: [], outOfRange: true };

  const spec = sortSpec(sort, { hasText: Boolean(filter.$text) });
  const cursor = spec.projection ? Listing.find(filter, spec.projection) : Listing.find(filter);
  const listings = await cursor
    .sort(spec.sort)
    .skip((requested - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE);
  return { ...base, listings, outOfRange: false };
}

module.exports = {
  PAGE_SIZE,
  sortSpec,
  searchPage,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildFilter,
  searchFilterFor,
  searchListings,
  explainSearch,
};
