// The listings page with search (P05-T02): /listings and its URL parameters.
//
// Filters come from the search service (P05-T01); dates are applied through
// the night ledger (a listing with any taken night in the stay is left out);
// `page` pages the results. Sorting (`sort`) and the rating filter
// (`minRating`) are validated and kept in every link, but only start to act in
// P05-T03 and P12-T02.
const Listing = require("../models/listing");
const ledger = require("../services/ledger");
const { buildFilter } = require("../services/search");
const { suggestForEmptyResults } = require("../services/suggestions");
const { parseListingQuery } = require("../validation/searchQuery");
const { formatDateOnly, todayIn, DEFAULT_TIMEZONE } = require("../utils/dates");

const PAGE_SIZE = 12;

module.exports.PAGE_SIZE = PAGE_SIZE;

module.exports.index = async (req, res) => {
  const now = new Date();
  const parsed = parseListingQuery(req.query, { now });

  const filter = buildFilter(parsed.searchParams);
  let taken = [];
  if (parsed.stay) {
    taken = await ledger.unavailableListingIds(
      parsed.stay.checkIn,
      parsed.stay.checkOut,
      { now },
    );
    if (taken.length > 0) filter._id = { $nin: taken };
  }

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

  // A search that found nothing gets suggestions (P05-T05): at most 5 more queries.
  const suggestions =
    total === 0 && filtered
      ? await suggestForEmptyResults({ Listing, parsed, takenIds: taken })
      : undefined;

  res.render("listings/index.ejs", {
    allListings: listings,
    state: { ...pageState, ...(page > 1 ? { page } : {}) },
    pageState,
    form: parsed.form,
    errors: parsed.errors,
    total,
    page,
    totalPages,
    filtered,
    suggestions,
    today: formatDateOnly(todayIn(DEFAULT_TIMEZONE, now)),
    pageTitle: filtered ? "Search results" : "Explore stays",
    pageDescription: "Browse places to stay on Dimora.",
  });
};
