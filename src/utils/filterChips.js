// What the listings page shows about its filters (P05-T04), made from the
// validated state (see src/validation/searchQuery.js) and nothing else:
//   activeChips(state)      one chip per active filter, each with a link that
//                           removes just that filter and keeps the rest
//   filterCount(state)      how many filters the filter panel owns are on
//   resetFiltersHref(state) the page without the panel's filters and category
//   categoryLinks(state)    the category strip: "All" first, then each category
// Labels are plain text; the views escape them.
const {
  PROPERTY_TYPES,
  ROOM_TYPES,
  AMENITIES,
} = require("../config/constants");
const { CATEGORIES, getCategory } = require("../config/categories");
const { listingsUrl } = require("./searchUrl");

// The filters the filter panel edits (the rest of the state is carried through
// the panel form as hidden inputs, see hiddenFields in searchUrl.js).
const PANEL_FIELDS = Object.freeze([
  "minPrice",
  "maxPrice",
  "type",
  "roomType",
  "bedrooms",
  "amenities",
  "instantBook",
]);

const labelOf = (list) => new Map(list.map((item) => [item.value, item.label]));
const PROPERTY_LABELS = labelOf(PROPERTY_TYPES);
const ROOM_LABELS = labelOf(ROOM_TYPES);
const AMENITY_LABELS = labelOf(AMENITIES);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-24" -> "24 Dec 2026" (text only, no Date, so no time zone can shift it). */
function dayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return String(value);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const asList = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** The list without one value (undefined when nothing is left, which removes the parameter). */
const without = (value, item) => {
  const rest = asList(value).filter((entry) => entry !== item);
  return rest.length ? rest : undefined;
};

/**
 * @param {object} state  the validated URL state
 * @returns {Array<{ key: string, label: string, href: string }>} in a fixed order
 */
function activeChips(state = {}) {
  const chips = [];
  const add = (key, label, changes) =>
    chips.push({ key, label, href: listingsUrl(state, changes) });

  if (state.dest) add("dest", `Where: ${state.dest}`, { dest: undefined });
  if (state.in && state.out) {
    add("dates", `${dayLabel(state.in)} to ${dayLabel(state.out)}`, { in: undefined, out: undefined, flex: undefined });
  }
  if (state.flex === 3 && state.in && state.out) {
    add("flex", "Available ±3 days", { flex: undefined });
  }
  if (Number.isInteger(state.guests)) {
    add("guests", plural(state.guests, "guest", "guests"), { guests: undefined });
  }

  const category = getCategory(state.category);
  if (category) add("category", category.label, { category: undefined });

  const hasMin = typeof state.minPrice === "number";
  const hasMax = typeof state.maxPrice === "number";
  if (hasMin || hasMax) {
    const label =
      hasMin && hasMax
        ? `${rupees(state.minPrice)} to ${rupees(state.maxPrice)} a night`
        : hasMin
          ? `From ${rupees(state.minPrice)} a night`
          : `Up to ${rupees(state.maxPrice)} a night`;
    add("price", label, { minPrice: undefined, maxPrice: undefined });
  }

  for (const value of asList(state.type)) {
    add(`type:${value}`, PROPERTY_LABELS.get(value) ?? value, { type: without(state.type, value) });
  }
  for (const value of asList(state.roomType)) {
    add(`roomType:${value}`, ROOM_LABELS.get(value) ?? value, { roomType: without(state.roomType, value) });
  }
  if (Number.isInteger(state.bedrooms) && state.bedrooms > 0) {
    add("bedrooms", `${state.bedrooms}+ bedrooms`, { bedrooms: undefined });
  }
  for (const value of asList(state.amenities)) {
    add(`amenity:${value}`, AMENITY_LABELS.get(value) ?? value, { amenities: without(state.amenities, value) });
  }
  if (state.instantBook === true) add("instantBook", "Instant book", { instantBook: undefined });
  if (typeof state.minRating === "number") {
    add("minRating", `Rated ${state.minRating}+`, { minRating: undefined });
  }
  if (state.keywords) add("keywords", `Keywords: ${state.keywords}`, { keywords: undefined });

  return chips;
}

/** How many of the filter panel's filters are on (a price range counts once). */
function filterCount(state = {}) {
  let count = 0;
  if (typeof state.minPrice === "number" || typeof state.maxPrice === "number") count += 1;
  count += asList(state.type).length;
  count += asList(state.roomType).length;
  if (Number.isInteger(state.bedrooms) && state.bedrooms > 0) count += 1;
  count += asList(state.amenities).length;
  if (state.instantBook === true) count += 1;
  return count;
}

/** The page without the panel's filters and the category (search, dates and guests stay). */
function resetFiltersHref(state = {}) {
  const changes = { category: undefined };
  for (const name of PANEL_FIELDS) changes[name] = undefined;
  return listingsUrl(state, changes);
}

/**
 * The strip: "All stays" and every category, each with the link that selects it
 * (the rest of the search is kept, the page goes back to 1) and whether it is
 * the current one. Choosing "All" removes the category.
 */
function categoryLinks(state = {}) {
  const active = getCategory(state.category);
  return [
    {
      slug: "",
      label: "All stays",
      icon: "fa-border-all",
      href: listingsUrl(state, { category: undefined }),
      active: !active,
    },
    ...CATEGORIES.map((category) => ({
      slug: category.slug,
      label: category.label,
      icon: category.icon,
      href: listingsUrl(state, { category: category.slug }),
      active: Boolean(active) && active.slug === category.slug,
    })),
  ];
}

module.exports = {
  PANEL_FIELDS,
  activeChips,
  filterCount,
  resetFiltersHref,
  categoryLinks,
  dayLabel,
};
