// The listings page with search (P05-T02): /listings and its URL parameters.
//
// Filters come from the search service (P05-T01); dates are applied through
// the night ledger (a listing with any taken night in the stay is left out);
// `page` pages the results. Sorting (`sort`) and the rating filter
// (`minRating`) are validated and kept in every link, but only start to act in
// P05-T03 and P12-T02. The category strip, the filter panel and the chips for
// the active filters (P05-T04) are built from the same validated state.
const Listing = require("../models/listing");
const { listingFilterFor } = require("../services/listingFilter");
const { searchMap } = require("../services/mapSearch");
const { parseBbox } = require("../utils/bbox");
const { ValidationError } = require("../utils/errors");
const { queryPairs } = require("../utils/searchUrl");
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

const PAGE_SIZE = 12;

module.exports.PAGE_SIZE = PAGE_SIZE;

module.exports.index = async (req, res) => {
  const now = new Date();
  const { parsed, filter } = await listingFilterFor(req.query, { now });

  const total = await Listing.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(parsed.page, totalPages);
  const listings = await Listing.find(filter)
    .sort({ _id: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE);

  const pageState = { ...parsed.state };
  delete pageState.page;
  const filtered = Object.keys(pageState).length > 0;
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
      lists: { PROPERTY_TYPES, ROOM_TYPES, AMENITIES },
    },
    mapQuery: new URLSearchParams(queryPairs(pageState)).toString(),
    total,
    page,
    totalPages,
    filtered,
    today: formatDateOnly(todayIn(DEFAULT_TIMEZONE, now)),
    pageTitle: filtered ? "Search results" : "Explore stays",
    pageDescription: "Browse places to stay on Dimora.",
  });
};

// GET /api/search/map?bbox=west,south,east,north&<the listings page filters>
// GeoJSON of at most MAP_RESULT_CAP stays (approximate points only); without
// `bbox` it covers every place. `meta` says how many matched and whether the
// list was cut. Wrong filter values are ignored as on the page; a wrong bbox is
// a 400.
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
