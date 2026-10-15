// Data for the home page (P03-T05): the newest stays and the places that have
// the most stays. Until listings have a publish status (P04-T05) every stored
// listing counts as published.
const { toCardItem } = require("../utils/listingCard");

const SCAN_LIMIT = 100; // newest listings looked at; keeps the query cheap
const FEATURED_LIMIT = 6;
const DESTINATION_LIMIT = 6;

const squash = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Groups listings by place (case-insensitive location + country) and returns
 * the busiest places first; ties are broken by name so the order is stable.
 * Each destination: { label, search, count, imageUrl }. `search` is the text
 * the listings page gets as ?search=.
 */
function pickDestinations(listings, limit = DESTINATION_LIMIT) {
  const groups = new Map();
  for (const listing of listings) {
    const location = squash(listing && listing.location);
    if (!location) continue;
    const country = squash(listing.country);
    const key = `${location}|${country}`.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        label: country ? `${location}, ${country}` : location,
        search: location,
        count: 0,
        imageUrl: null,
      };
      groups.set(key, group);
    }
    group.count += 1;
    if (!group.imageUrl && listing.image && listing.image.url) {
      group.imageUrl = listing.image.url;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, limit));
}

async function loadHomeData(
  ListingModel,
  { scan = SCAN_LIMIT, featured = FEATURED_LIMIT } = {},
) {
  const docs = await ListingModel.find({})
    .select("title image pricing location country")
    .sort({ _id: -1 })
    .limit(scan)
    .lean();
  const listings = Array.isArray(docs) ? docs : [];
  return {
    featured: listings.slice(0, featured).map(toCardItem),
    destinations: pickDestinations(listings),
  };
}

module.exports = { loadHomeData, pickDestinations };
