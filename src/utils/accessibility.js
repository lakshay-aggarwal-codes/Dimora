// Accessibility features for the listing page (P15-T05): stored keys to labels.
// The host declares them and Dimora has not checked them; keys that are not in
// the shared list (old data, a typo) are dropped, never shown raw, and each
// feature appears once, in the list's own order.
const { ACCESSIBILITY_FEATURES } = require("../config/constants");

/** Labels of the declared features, in a fixed order. */
function accessibilityLabels(keys) {
  const chosen = new Set(Array.isArray(keys) ? keys : []);
  return ACCESSIBILITY_FEATURES.filter((item) => chosen.has(item.value)).map(
    (item) => item.label,
  );
}

module.exports = { accessibilityLabels };
