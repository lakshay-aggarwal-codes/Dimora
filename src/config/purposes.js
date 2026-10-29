// Trip purposes for the listings page (P15-T06). A purpose does NOT filter: it
// changes the order of "Best match" by giving each stay points for things the
// listing really states. The rules are listed here, shown on the page, and are
// the only thing the ranking uses; there is no learning and no hidden weight.
//
// A rule is one of
//   { kind: "amenity", value }     the listing has that amenity
//   { kind: "roomType", value }    the guest gets that kind of space
//   { kind: "minBedrooms", value } capacity.bedrooms is at least value
//   { kind: "minGuests", value }   capacity.guests is at least value
//   { kind: "instantBook" }        the stay can be booked without waiting for the host
// Points are small whole numbers; ties keep the normal order (rating, then number of reviews).
const rule = (label, points, kind, value) => Object.freeze({ label, points, kind, value });

const PURPOSES = Object.freeze([
  Object.freeze({
    slug: "work",
    label: "Work trip",
    summary: "A reliable connection and a place to work.",
    rules: Object.freeze([
      rule("Wi-Fi", 3, "amenity", "wifi"),
      rule("Dedicated workspace", 3, "amenity", "workspace"),
      rule("The whole place to yourself", 1, "roomType", "entire_place"),
      rule("Air conditioning", 1, "amenity", "air_conditioning"),
    ]),
  }),
  Object.freeze({
    slug: "family",
    label: "Family trip",
    summary: "Room for everyone and a kitchen.",
    rules: Object.freeze([
      rule("2 or more bedrooms", 3, "minBedrooms", 2),
      rule("Sleeps 4 or more", 2, "minGuests", 4),
      rule("Kitchen", 2, "amenity", "kitchen"),
      rule("The whole place to yourselves", 2, "roomType", "entire_place"),
      rule("Washing machine", 1, "amenity", "washer"),
      rule("Free parking", 1, "amenity", "free_parking"),
      rule("Smoke alarm", 1, "amenity", "smoke_alarm"),
      rule("First aid kit", 1, "amenity", "first_aid_kit"),
    ]),
  }),
  Object.freeze({
    slug: "weekend",
    label: "Weekend getaway",
    summary: "Something to enjoy, and easy to book.",
    rules: Object.freeze([
      rule("Pool", 2, "amenity", "pool"),
      rule("Balcony or terrace", 2, "amenity", "balcony"),
      rule("Instant book", 2, "instantBook"),
      rule("Free parking", 1, "amenity", "free_parking"),
      rule("Air conditioning", 1, "amenity", "air_conditioning"),
    ]),
  }),
]);

const PURPOSE_SLUGS = Object.freeze(PURPOSES.map((p) => p.slug));
const BY_SLUG = new Map(PURPOSES.map((p) => [p.slug, p]));

/** The purpose for a slug, or null (also for anything that is not a string). */
function getPurpose(slug) {
  return typeof slug === "string" && BY_SLUG.has(slug) ? BY_SLUG.get(slug) : null;
}

module.exports = { PURPOSES, PURPOSE_SLUGS, getPurpose };
