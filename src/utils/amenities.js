// Amenities for the listing page (P04-T07): the stored keys, grouped and
// labelled. Keys that are not in the shared list (old data, a typo) are
// dropped, never shown raw, and each amenity appears once.
const { AMENITIES, AMENITY_GROUPS } = require("../config/constants");

const BY_VALUE = new Map(AMENITIES.map((item) => [item.value, item]));

/** [{ group, items: [label] }] in a fixed group order; empty groups left out. */
function groupAmenities(keys) {
  const chosen = new Set(Array.isArray(keys) ? keys : []);
  return AMENITY_GROUPS.map((group) => ({
    group,
    items: AMENITIES.filter(
      (item) => item.group === group && chosen.has(item.value),
    ).map((item) => item.label),
  })).filter((entry) => entry.items.length > 0);
}

/** The label for one stored value, or null if it is not a known amenity. */
const amenityLabel = (value) => (BY_VALUE.get(value) || {}).label ?? null;

module.exports = { groupAmenities, amenityLabel };
