// Re-ordering "Best match" for a trip purpose (P15-T06; rules in
// src/config/purposes.js, explained on docs/RANKING.md).
//
// The score of a stay is the sum of the points of the rules it meets. Stays are
// ordered by score, highest first; stays with the same score keep the normal
// "Best match" order (rating, number of reviews, newest). The scoring is done in
// JavaScript on a small projection, so there is one definition of the rules and
// the page and the tests use the same one.
//
// Limit: only the MAX_RANKED best-matching stays (by the normal order) are
// scored; a search with more matches than that is ranked within its first
// MAX_RANKED. Pages past it keep the normal order.
const MAX_RANKED = 2000;
// The normal "Best match" order without search words (services/search.js
// sortSpec("relevance")); tests/unit/purposeRank.sync.test.js keeps them equal.
const NORMAL_ORDER = Object.freeze({ ratingAvg: -1, ratingCount: -1, _id: -1 });
const FIELDS = "amenities roomType capacity instantBook ratingAvg ratingCount";

function meets(rule, listing) {
  const l = listing || {};
  switch (rule.kind) {
    case "amenity":
      return Array.isArray(l.amenities) && l.amenities.includes(rule.value);
    case "roomType":
      return l.roomType === rule.value;
    case "minBedrooms":
      return Number(l.capacity && l.capacity.bedrooms) >= rule.value;
    case "minGuests":
      return Number(l.capacity && l.capacity.guests) >= rule.value;
    case "instantBook":
      return l.instantBook === true;
    default:
      return false;
  }
}

/** { score, matched: [rule, ...] } for one listing (document or plain object). */
function scoreListing(purpose, listing) {
  const matched = purpose.rules.filter((rule) => meets(rule, listing));
  return { score: matched.reduce((sum, rule) => sum + rule.points, 0), matched };
}

const maxScore = (purpose) => purpose.rules.reduce((sum, rule) => sum + rule.points, 0);

/**
 * One page of `filter` ordered for `purpose`.
 * @returns {Promise<object[]>} Listing documents, in order
 */
async function rankedPage({ Listing, filter, purpose, page, pageSize }) {
  const rows = await Listing.find(filter)
    .select(FIELDS)
    .sort({ ...NORMAL_ORDER })
    .limit(MAX_RANKED)
    .lean();
  const scored = (Array.isArray(rows) ? rows : []).map((row, index) => ({
    id: row._id,
    index,
    score: scoreListing(purpose, row).score,
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const start = (page - 1) * pageSize;
  const ids = scored.slice(start, start + pageSize).map((s) => s.id);
  if (ids.length === 0) return [];
  const docs = await Listing.find({ _id: { $in: ids } });
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

module.exports = { NORMAL_ORDER, MAX_RANKED, scoreListing, maxScore, meets, rankedPage };
