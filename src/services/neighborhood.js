// What the public listing page shows about the surroundings (P15-T02).
//
// A pure function over `listing.nearby` (stored by src/services/nearby.js, P15-T01):
// no network, no database. Guests only ever read stored data.
//
// Privacy: the stored items have no coordinates at all, and their distances are
// already measured from the PUBLIC (approximate) point. Here they are rounded
// again, to the nearest 50 m, and the map layer is just one dashed circle per
// category around that approximate centre: a radius, never a position. So the
// rule "no per-item coordinates when fewer than 3 places are within 500 m" holds
// by construction: there are never any.
const { CATEGORIES, SOURCE } = require("../config/nearby");

const STEP_M = 50;

/** Nearest 50 m, never below 50 ("about 0 m" would mean "on the spot"). */
const roundDistance = (meters) => Math.max(STEP_M, Math.round(meters / STEP_M) * STEP_M);

function distanceLabel(roundedM) {
  const text =
    roundedM < 1000 ? `${roundedM} m` : `${(Math.round(roundedM / 100) / 10).toFixed(1)} km`;
  return `\u2248 ${text} straight-line`;
}

/** @returns {null | {fetchedOn:string, source:string, categories:object[], rings:object[]}} null = show nothing */
function neighborhoodFor(listing) {
  const stored = listing && listing.nearby;
  if (!stored || !stored.fetchedAt || !Array.isArray(stored.items)) return null;

  const categories = [];
  for (const category of CATEGORIES) {
    const items = stored.items
      .filter(
        (item) =>
          item &&
          item.category === category.id &&
          Number.isFinite(item.distanceM) &&
          item.distanceM >= 0,
      )
      .map((item) => ({
        name: item.name || null,
        kindLabel: item.kind ? String(item.kind).replace(/_/g, " ") : "place",
        distanceM: roundDistance(item.distanceM),
      }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .map((item) => ({ ...item, distanceLabel: distanceLabel(item.distanceM) }));
    if (items.length) {
      categories.push({
        id: category.id,
        label: category.label,
        items,
        nearestM: items[0].distanceM,
      });
    }
  }
  if (!categories.length) return null;

  return {
    fetchedOn: stored.fetchedAt.toISOString().slice(0, 10),
    source: stored.source || SOURCE,
    categories,
    // For the map: one circle per category, radius = its nearest place.
    rings: categories.map((c) => ({ id: c.id, label: c.label, radiusM: c.nearestM })),
  };
}

module.exports = { neighborhoodFor, roundDistance, distanceLabel };
