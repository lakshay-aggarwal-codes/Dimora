// The listings page with search (P05-T02): /listings and its URL parameters.
//
// Filters come from the search service (P05-T01); dates are applied through
// the night ledger (a listing with any taken night in the stay is left out).
// Sorting and paging (P05-T03): five sort orders, 12 to a page, and a page past
// the last one is a normal 200 page that explains and links to the last page
// (the list itself is not fetched then). The rating filter (`minRating`) is
// validated and kept in every link, but only starts to act in P12-T02. The
// category strip, the filter panel and the chips for the active filters
// (P05-T04) and the suggestions for an empty search (P05-T05) are built from
// the same validated state.
const Listing = require("../models/listing");
const { listingFilterFor } = require("../services/listingFilter");
const { searchMap } = require("../services/mapSearch");
const { parseBbox } = require("../utils/bbox");
const { ValidationError } = require("../utils/errors");
const { queryPairs, listingsUrl, hiddenFields } = require("../utils/searchUrl");
const { sortSpec } = require("../services/search");
const { suggestForEmptyResults } = require("../services/suggestions");
const { suggestDestinations } = require("../services/destinations");
const ListingStat = require("../models/listingStat");
const { PURPOSES, getPurpose } = require("../config/purposes");
const { rankedPage, maxScore } = require("../services/purposeRank");
const { recordShown } = require("../services/rankingStats");
const { formatDateOnly, todayIn, DEFAULT_TIMEZONE } = require("../utils/dates");
const {
  activeChips,
  filterCount,
  resetFiltersHref,
  categoryLinks,
  PANEL_FIELDS,
} = require("../utils/filterChips");
const { getCategory } = require("../config/categories");
const { PROPERTY_TYPES, ROOM_TYPES, AMENITIES } = require("../config/constants");
const { RADII_KM } = require("../services/area");

const PAGE_SIZE = 12;

module.exports.PAGE_SIZE = PAGE_SIZE;

// The sort choices offered on the listings page, in the order shown.
const SORT_OPTIONS = Object.freeze([
  { value: "relevance", label: "Best match" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Top rated" },
  { value: "newest", label: "Newest" },
]);
const DEFAULT_SORT = "relevance";

module.exports.SORT_OPTIONS = SORT_OPTIONS;

module.exports.index = async (req, res) => {
  const now = new Date();
  const { parsed, filter, takenIds } = await listingFilterFor(req.query, {
    now,
  });
  const sort = parsed.state.sort || DEFAULT_SORT;
  const requested = parsed.page;

  const total = await Listing.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A page past the last one (with results to show) is explained, not fetched.
  const outOfRange = total > 0 && requested > totalPages;
  const page = Math.min(requested, totalPages);

  // A trip purpose re-orders "Best match" (P15-T06). It needs that sort and no
  // search words (words have their own relevance), and says so when it cannot act.
  const purpose = getPurpose(parsed.state.purpose);
  const hasText = Boolean(filter.$text);
  const purposeActive = Boolean(purpose) && sort === "relevance" && !hasText;
  // Which ordering the page shows, for the click-through comparison; null for
  // the other sort orders and for word searches (not comparable).
  const rankVariant = sort === "relevance" && !hasText ? (purpose ? purpose.slug : "default") : null;

  let listings = [];
  if (!outOfRange) {
    if (purposeActive) {
      listings = await rankedPage({ Listing, filter, purpose, page, pageSize: PAGE_SIZE });
    } else {
      const spec = sortSpec(sort, { hasText });
      const cursor = spec.projection
        ? Listing.find(filter, spec.projection)
        : Listing.find(filter);
      listings = await cursor
        .sort(spec.sort)
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE);
    }
    // Counters only, never in the way of the page, and not for crawlers.
    if (rankVariant && listings.length > 0 && !/bot|crawl|spider|preview|monitor/i.test(req.get("user-agent") || "")) {
      recordShown({ ListingStat, ids: listings.map((l) => l._id), variant: rankVariant }).catch(() => {});
    }
  }

  const pageState = { ...parsed.state };
  delete pageState.page;
  // A sort order alone is not a search.
  const filterState = { ...pageState };
  delete filterState.sort;
  delete filterState.purpose;
  const filtered = Object.keys(filterState).length > 0;

  // Sort links keep the search and start again at page 1.
  const sortLinks = SORT_OPTIONS.map((option) => ({
    ...option,
    current: option.value === sort,
    href: listingsUrl(pageState, {
      sort: option.value === DEFAULT_SORT ? undefined : option.value,
    }),
  }));
  // "Plan for": the purposes, each as a link that keeps the search (P15-T06).
  const purposeLinks = [
    { slug: "", label: "Any trip", current: !purpose, href: listingsUrl(pageState, { purpose: undefined }) },
    ...PURPOSES.map((p) => ({
      slug: p.slug,
      label: p.label,
      current: Boolean(purpose) && purpose.slug === p.slug,
      href: listingsUrl(pageState, { purpose: p.slug }),
    })),
  ];
  const purposeInfo = purpose
    ? {
        slug: purpose.slug,
        label: purpose.label,
        summary: purpose.summary,
        rules: purpose.rules,
        max: maxScore(purpose),
        active: purposeActive,
        why: purposeActive
          ? null
          : hasText
            ? "Trip ranking is off while you search by words."
            : "Trip ranking only applies to the Best match order.",
      }
    : null;

  const from = (page - 1) * PAGE_SIZE + 1;
  const showing =
    total > 0 && !outOfRange && totalPages > 1
      ? { from, to: from + listings.length - 1 }
      : null;

  // Only an empty, filtered search gets suggestions (at most 5 extra queries).
  const suggestions =
    total === 0 && filtered
      ? await suggestForEmptyResults({ Listing, parsed, takenIds })
      : null;

  res.render("listings/index.ejs", {
    allListings: listings,
    state: { ...pageState, ...(page > 1 ? { page } : {}) },
    pageState,
    form: parsed.form,
    errors: parsed.errors,
    chips: activeChips(pageState),
    filterCount: filterCount(pageState),
    resetFiltersHref: resetFiltersHref(pageState),
    categories: categoryLinks(pageState),
    activeCategory: getCategory(pageState.category),
    panel: {
      values: pageState,
      typed: parsed.drawer,
      fields: PANEL_FIELDS,
      lists: { PROPERTY_TYPES, ROOM_TYPES, AMENITIES, RADII_KM },
    },
    hiddenFields,
    mapQuery: new URLSearchParams(queryPairs(pageState)).toString(),
    sortLinks,
    purposeLinks,
    purposeInfo,
    rankVariant,
    showing,
    outOfRange,
    lastPageHref: listingsUrl(pageState, { page: totalPages }),
    suggestions,
    total,
    page,
    totalPages,
    filtered,
    suggestions,
    today: formatDateOnly(todayIn(DEFAULT_TIMEZONE, now)),
    pageTitle: filtered
      ? "Search results"
      : page > 1
        ? `Explore stays (page ${page})`
        : "Explore stays",
    pageDescription: "Browse places to stay on Dimora.",
  });
};

// GET /api/search/map?bbox=west,south,east,north&<the listings page filters>
// GeoJSON of at most MAP_RESULT_CAP stays (approximate points only); without
// `bbox` it covers every place. `meta` says how many matched and whether the
// list was cut. Wrong filter values are ignored as on the page; a wrong bbox is
// a 400.
// Suggestions for the destination boxes (P05-T06). `q` is whatever was typed; a
// missing, repeated or too short `q` is an empty list, not an error.
module.exports.destinations = async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const suggestions = await suggestDestinations({ Listing, q });
  res.set("Cache-Control", "private, max-age=30");
  res.json({ suggestions });
};

module.exports.mapData = async (req, res) => {
  let boxes = null;
  if (req.query.bbox !== undefined) {
    const box = parseBbox(req.query.bbox);
    if (!box.ok) throw new ValidationError(box.message);
    boxes = box.boxes;
  }
  const { filter } = await listingFilterFor(req.query);
  const result = await searchMap(Listing, filter, boxes);
  res.set("Cache-Control", "no-store");
  res.json(result);
};
