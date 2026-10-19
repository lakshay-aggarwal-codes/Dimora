// The category strip on /listings (P05-T04). Every category is a rule over a
// field the Listing model really has, so a category link can only ever return
// listings that match it. `field` is one of:
//   vibe          the setting a host chose (beach, mountain, ...)
//   propertyType  the kind of property
//   roomType      what the guest gets
//   amenities     a listing must have ALL of the `values`
// A category the data cannot back (Trending, Castles, Skiing, ...) is not here.
// `slug` is what the URL carries: /listings?category=beach
const CATEGORIES = Object.freeze(
  [
    { slug: "beach", label: "Beach", icon: "fa-umbrella-beach", field: "vibe", values: ["beach"] },
    { slug: "mountains", label: "Mountains", icon: "fa-mountain-sun", field: "vibe", values: ["mountain"] },
    { slug: "lakefront", label: "Lakefront", icon: "fa-water", field: "vibe", values: ["lake"] },
    { slug: "desert", label: "Desert", icon: "fa-sun", field: "vibe", values: ["desert"] },
    { slug: "countryside", label: "Countryside", icon: "fa-tree", field: "vibe", values: ["countryside"] },
    { slug: "city", label: "City", icon: "fa-city", field: "vibe", values: ["city"] },
    { slug: "farm-stays", label: "Farm stays", icon: "fa-tractor", field: "propertyType", values: ["farm_stay"] },
    { slug: "cabins", label: "Cabins", icon: "fa-house-chimney", field: "propertyType", values: ["cabin"] },
    { slug: "villas", label: "Villas", icon: "fa-landmark", field: "propertyType", values: ["villa"] },
    { slug: "apartments", label: "Apartments", icon: "fa-building", field: "propertyType", values: ["apartment"] },
    { slug: "amazing-pools", label: "Amazing pools", icon: "fa-person-swimming", field: "amenities", values: ["pool"] },
    { slug: "rooms", label: "Rooms", icon: "fa-bed", field: "roomType", values: ["private_room", "shared_room"] },
  ].map((category) => Object.freeze({ ...category, values: Object.freeze([...category.values]) })),
);

const CATEGORY_SLUGS = Object.freeze(CATEGORIES.map((category) => category.slug));
const BY_SLUG = new Map(CATEGORIES.map((category) => [category.slug, category]));

/** The category for a slug, or null (also for anything that is not a string). */
function getCategory(slug) {
  return typeof slug === "string" ? (BY_SLUG.get(slug) ?? null) : null;
}

/**
 * The Mongo condition a category stands for, or null for an unknown slug.
 * Built only from this file's constants, never from request text.
 */
function categoryClause(slug) {
  const category = getCategory(slug);
  if (!category) return null;
  const values = [...category.values];
  return category.field === "amenities"
    ? { amenities: { $all: values } }
    : { [category.field]: { $in: values } };
}

module.exports = { CATEGORIES, CATEGORY_SLUGS, getCategory, categoryClause };
