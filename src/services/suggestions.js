// What to offer when a search finds nothing (P05-T05).
//
// Two kinds of suggestion, both guaranteed to lead somewhere:
//   * "Remove this filter": for some of the active filters, how many stays there
//     would be without it. Only filters whose removal gives at least one stay
//     are offered, the ones giving most stays first.
//   * Popular destinations: places that really have stays, linked with NO other
//     filter, so each of them has results by construction.
// A "clear all filters" link is offered only when there is any stay at all.
//
// Cost: at most MAX_EXTRA_QUERIES (5) database queries per empty search: up to
// 4 counts (one per filter group looked at) and 1 for the destinations. With more
// than 4 active filter groups only the first 4 in GROUPS order are looked at.
const { buildFilter } = require("./search");
const { publicListingFilter } = require("../utils/visibility");
const { destinationParts, normaliseToken } = require("../utils/searchKeys");
const { listingsUrl } = require("../utils/searchUrl");

const MAX_EXTRA_QUERIES = 5;
const MAX_FILTER_COUNTS = MAX_EXTRA_QUERIES - 1; // one query is kept for destinations
const MAX_FILTER_SUGGESTIONS = 3;
const MAX_DESTINATIONS = 6;
const SCAN_LIMIT = 200; // newest public listings looked at for destinations

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A filter group: the URL parameters it owns, the search-service parameters it
// owns, when it is active and how to describe removing it. In the order they
// are looked at (dates and amenities usually remove the most stays).
const GROUPS = [
  {
    key: "radius",
    urlKeys: ["radius"],
    serviceKeys: [],
    active: (p) => Boolean(p.area),
    label: (s) => `Search only "${s.dest}" itself, not ${s.radius} km around it`,
  },
  {
    key: "dates",
    urlKeys: ["in", "out"],
    serviceKeys: [], // dates act through the night ledger, not the filter
    active: (p) => Boolean(p.stay),
    label: (s) => `Remove the dates (${s.in} to ${s.out})`,
  },
  {
    key: "amenities",
    urlKeys: ["amenities"],
    serviceKeys: ["amenities"],
    active: (p) => Array.isArray(p.searchParams.amenities) && p.searchParams.amenities.length > 0,
    label: () => "Remove the amenity filters",
  },
  {
    key: "access",
    urlKeys: ["access"],
    serviceKeys: ["access"],
    active: (p) => Array.isArray(p.searchParams.access) && p.searchParams.access.length > 0,
    label: () => "Remove the accessibility filters",
  },
  {
    key: "price",
    urlKeys: ["minPrice", "maxPrice"],
    serviceKeys: ["minPrice", "maxPrice"],
    active: (p) => p.searchParams.minPrice !== undefined || p.searchParams.maxPrice !== undefined,
    label: () => "Remove the price limit",
  },
  {
    key: "type",
    urlKeys: ["type"],
    serviceKeys: ["propertyType"],
    active: (p) => Array.isArray(p.searchParams.propertyType) && p.searchParams.propertyType.length > 0,
    label: () => "Allow any property type",
  },
  {
    key: "guests",
    urlKeys: ["guests"],
    serviceKeys: ["guests"],
    active: (p) => p.searchParams.guests !== undefined,
    label: (s) => `Remove the guest count (${plural(s.guests, "guest", "guests")})`,
  },
  {
    key: "instantBook",
    urlKeys: ["instantBook"],
    serviceKeys: ["instantBook"],
    active: (p) => p.searchParams.instantBook === true,
    label: () => "Include stays that are not instant book",
  },
  {
    key: "roomType",
    urlKeys: ["roomType"],
    serviceKeys: ["roomType"],
    active: (p) => Array.isArray(p.searchParams.roomType) && p.searchParams.roomType.length > 0,
    label: () => "Allow any room type",
  },
  {
    key: "bedrooms",
    urlKeys: ["bedrooms"],
    serviceKeys: ["bedrooms"],
    active: (p) => p.searchParams.bedrooms !== undefined,
    label: () => "Remove the bedroom minimum",
  },
  {
    key: "keywords",
    urlKeys: ["keywords"],
    serviceKeys: ["keywords"],
    active: (p) => typeof p.searchParams.keywords === "string" && p.searchParams.keywords !== "",
    label: (s) => `Remove the words "${s.keywords}"`,
  },
  {
    key: "destination",
    urlKeys: ["dest", "radius"],
    serviceKeys: ["destination"],
    active: (p) => destinationParts(p.searchParams.destination).length > 0,
    label: (s) => `Search everywhere instead of "${s.dest}"`,
  },
];

/** The filter the page would use without one group of filters. */
function filterWithout(parsed, group, takenIds) {
  const params = { ...parsed.searchParams };
  for (const key of group.serviceKeys) delete params[key];
  // With a radius the circle replaces the destination text (P06-T05); removing
  // the radius or the destination itself brings the plain search back.
  const keepArea = parsed.area && group.key !== "radius" && group.key !== "destination";
  if (keepArea) delete params.destination;
  const filter = { ...buildFilter(params), ...(keepArea ? parsed.area.condition : {}) };
  // Taken nights still exclude listings, unless the dates are what is dropped.
  if (group.key !== "dates" && takenIds.length > 0) filter._id = { $nin: takenIds };
  return filter;
}

/**
 * Popular destinations from the newest public listings: the cities with the most
 * stays. The link text is the city as a host wrote it; if searching for exactly
 * that text would not find the city's own key, the normalised key is used
 * instead, so a destination link can never lead to an empty page.
 * @returns {Promise<Array<{ label: string, dest: string, count: number }>>}
 */
async function popularDestinations(Listing, limit = MAX_DESTINATIONS) {
  const listings = await Listing.find(publicListingFilter())
    .select("cityKey address.city location")
    .sort({ _id: -1 })
    .limit(SCAN_LIMIT)
    .lean();
  const groups = new Map();
  for (const listing of Array.isArray(listings) ? listings : []) {
    const key = listing && listing.cityKey;
    if (typeof key !== "string" || key === "") continue;
    const shown = String(
      (listing.address && listing.address.city) || listing.location || "",
    )
      .split(",")[0]
      .trim();
    const group = groups.get(key) || { key, label: shown, count: 0 };
    group.count += 1;
    if (!group.label && shown) group.label = shown;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((group) => {
      const parts = destinationParts(group.label);
      const safe = parts.length === 1 && parts[0] === normaliseToken(group.label) && group.key.startsWith(parts[0]);
      return {
        label: group.label && safe ? group.label : group.key,
        dest: safe ? group.label : group.key,
        count: group.count,
      };
    });
}

/**
 * @param {object} args
 * @param {object} args.Listing    the model
 * @param {object} args.parsed     the result of parseListingQuery
 * @param {Array}  [args.takenIds] listing ids with a taken night in the stay
 * @returns {Promise<{
 *   filterSuggestions: Array<{ key, label, count, url }>,
 *   destinations: Array<{ label, dest, count, url }>,
 *   hasAnyStays: boolean, queries: number }>}
 */
async function suggestForEmptyResults({ Listing, parsed, takenIds = [] }) {
  const looked = GROUPS.filter((group) => group.active(parsed)).slice(0, MAX_FILTER_COUNTS);

  const counts = await Promise.all(
    looked.map((group) => Listing.countDocuments(filterWithout(parsed, group, takenIds))),
  );
  const destinations = await popularDestinations(Listing);

  const state = { ...parsed.state };
  const filterSuggestions = looked
    .map((group, index) => ({ group, count: counts[index], index }))
    .filter(({ count }) => Number.isInteger(count) && count > 0) // never offer a dead end
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, MAX_FILTER_SUGGESTIONS)
    .map(({ group, count }) => ({
      key: group.key,
      label: group.label(state),
      count,
      url: listingsUrl(state, Object.fromEntries(group.urlKeys.map((k) => [k, undefined]))),
    }));

  return {
    filterSuggestions,
    destinations: destinations.map((d) => ({ ...d, url: listingsUrl({}, { dest: d.dest }) })),
    hasAnyStays: destinations.length > 0,
    queries: looked.length + 1,
  };
}

module.exports = {
  MAX_EXTRA_QUERIES,
  MAX_FILTER_COUNTS,
  MAX_FILTER_SUGGESTIONS,
  GROUPS,
  popularDestinations,
  suggestForEmptyResults,
};
