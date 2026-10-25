// The listings page's URL (P05-T02). One function turns `req.query` into
//   state         the valid parameters, in URL names (what links are built from)
//   form          what to show in the form inputs, even when it was invalid
//   errors        a message per parameter that was wrong
//   searchParams  the same filters under the search service's names (P05-T01)
//   stay          { checkIn, checkOut, flexDays } as date-only Dates when both
//                 are valid (flexDays: 3 when "Available +-3 days" is on, else 0)
//
// URL names: dest, in, out, guests, minPrice, maxPrice, type, amenities,
// minRating, sort, page (and, from the search service, keywords, bedrooms,
// roomType, instantBook) and `category` (one slug from the category strip,
// P05-T04). `destination` and the navbar's old `search` are
// accepted as `dest`; `amenities[]` as `amenities`; `propertyType` as `type`.
// Unknown names are ignored. A wrong value never stops the page: the valid
// parameters still search, and the errors are shown next to the form.
const Joi = require("joi");
const { parseSearchParams } = require("./search");
const {
  BOOKING_WINDOW,
  DEFAULT_TIMEZONE,
  addDays,
  formatDateOnly,
  nightsBetween,
  todayIn,
  tryParseDateOnly,
} = require("../utils/dates");

// "Available +-3 days" on the search page (P15-T04).
const FLEX_DAYS = 3;

const SORTS = Object.freeze([
  "relevance",
  "price_asc",
  "price_desc",
  "rating",
  "newest",
]);
const MAX_PAGE = 1000;

// URL name -> the name the search service uses.
const SERVICE_NAME = Object.freeze({
  dest: "destination",
  type: "propertyType",
});
const URL_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVICE_NAME).map(([url, service]) => [service, url]),
  ),
);

const isPlain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** First usable raw value of any of these names (strings or arrays only). */
function pick(raw, names) {
  for (const name of names) {
    if (Object.hasOwn(raw, name) && raw[name] !== undefined) return raw[name];
  }
  return undefined;
}

const numberSchema = (label, min, max, { integer = false } = {}) => {
  let schema = Joi.number().empty("").min(min).max(max).label(label);
  if (integer) schema = schema.integer();
  return schema;
};

const extraSchema = Joi.object({
  minRating: numberSchema("Minimum rating", 1, 5).messages({
    "number.base": "Minimum rating must be a number from 1 to 5.",
    "number.min": "Minimum rating must be a number from 1 to 5.",
    "number.max": "Minimum rating must be a number from 1 to 5.",
  }),
  sort: Joi.string()
    .valid(...SORTS)
    .empty("")
    .label("Sort")
    .messages({ "any.only": `Sort must be one of: ${SORTS.join(", ")}.` }),
  page: numberSchema("Page", 1, MAX_PAGE, { integer: true }).messages({
    "number.base": "Page must be a whole number from 1.",
    "number.integer": "Page must be a whole number from 1.",
    "number.min": "Page must be a whole number from 1.",
    "number.max": `Page must be at most ${MAX_PAGE}.`,
  }),
});

/** Dates: both or neither; real calendar days; today or later; at most 90 nights. */
function parseStay(rawIn, rawOut, { now, timeZone }) {
  const errors = {};
  const empty = (v) => v === undefined || v === "";
  if (empty(rawIn) && empty(rawOut)) return { errors };

  const parse = (value, name, label) => {
    if (empty(value)) {
      errors[name] =
        name === "in" ? "Choose a check-in date." : "Choose a check-out date.";
      return null;
    }
    if (typeof value !== "string") {
      errors[name] = `${label} must be a single date.`;
      return null;
    }
    const date = tryParseDateOnly(value);
    if (!date) {
      errors[name] = `${label} must be a date like 2026-12-24.`;
      return null;
    }
    return date;
  };
  const checkIn = parse(rawIn, "in", "Check-in");
  const checkOut = parse(rawOut, "out", "Check-out");
  if (!checkIn || !checkOut) return { errors };

  const today = todayIn(timeZone, now);
  if (checkIn.getTime() < today.getTime()) {
    errors.in = "Check-in cannot be in the past.";
  } else if (
    checkIn.getTime() >
    addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS).getTime()
  ) {
    errors.in = "Check-in is too far ahead.";
  } else if (checkOut.getTime() <= checkIn.getTime()) {
    errors.out = "Check-out must be after check-in.";
  } else if (
    nightsBetween(checkIn, checkOut) > BOOKING_WINDOW.MAX_STAY_NIGHTS
  ) {
    errors.out = `A stay can be at most ${BOOKING_WINDOW.MAX_STAY_NIGHTS} nights.`;
  }
  return Object.keys(errors).length
    ? { errors }
    : { checkIn, checkOut, errors };
}

/**
 * @param {object} query  req.query
 * @param {{ now?: Date, timeZone?: string }} [options]
 */
function parseListingQuery(
  query,
  { now = new Date(), timeZone = DEFAULT_TIMEZONE } = {},
) {
  const raw = isPlain(query) ? query : {};

  // ---- names the search service understands (P05-T01) ----
  const serviceInput = {
    destination: pick(raw, ["dest", "destination", "search"]),
    keywords: pick(raw, ["keywords"]),
    minPrice: pick(raw, ["minPrice"]),
    maxPrice: pick(raw, ["maxPrice"]),
    guests: pick(raw, ["guests"]),
    bedrooms: pick(raw, ["bedrooms"]),
    propertyType: pick(raw, ["type", "propertyType"]),
    roomType: pick(raw, ["roomType"]),
    amenities: pick(raw, ["amenities", "amenities[]"]),
    instantBook: pick(raw, ["instantBook"]),
    category: pick(raw, ["category"]),
  };
  for (const key of Object.keys(serviceInput)) {
    if (serviceInput[key] === undefined) delete serviceInput[key];
  }
  const { value: serviceValue, errors: serviceErrors } =
    parseSearchParams(serviceInput);

  const errors = {};
  for (const [name, message] of Object.entries(serviceErrors)) {
    errors[URL_NAME[name] || name] = message;
  }
  const state = {};
  for (const [name, value] of Object.entries(serviceValue)) {
    state[URL_NAME[name] || name] = value;
  }

  // ---- minRating, sort, page ----
  const extraRaw = {};
  for (const name of ["minRating", "sort", "page"]) {
    if (Object.hasOwn(raw, name)) extraRaw[name] = raw[name];
  }
  for (const [name, value] of Object.entries(extraRaw)) {
    const { error, value: ok } = extraSchema.extract(name).validate(value, {
      errors: { wrap: { label: false } },
    });
    if (error) errors[name] = error.details[0].message;
    else if (ok !== undefined) state[name] = ok;
  }

  // ---- dates ----
  const stay = parseStay(pick(raw, ["in"]), pick(raw, ["out"]), {
    now,
    timeZone,
  });
  Object.assign(errors, stay.errors);
  if (stay.checkIn) {
    state.in = formatDateOnly(stay.checkIn);
    state.out = formatDateOnly(stay.checkOut);
  }

  // ---- flexible dates (P15-T04): only "3" means on; it needs valid dates ----
  const rawFlex = pick(raw, ["flex"]);
  let flexDays = 0;
  if (rawFlex !== undefined && rawFlex !== "" && rawFlex !== "0") {
    if (rawFlex !== "3") {
      errors.flex = "Flexible dates can only be 3 days either side.";
    } else if (stay.checkIn) {
      flexDays = FLEX_DAYS;
      state.flex = FLEX_DAYS;
    }
  }

  // ---- what the form inputs show (strings only, even when invalid) ----
  const text = (names) => {
    const value = pick(raw, names);
    return typeof value === "string" ? value.slice(0, 100) : "";
  };
  const form = {
    dest: text(["dest", "destination", "search"]),
    in: text(["in"]),
    out: text(["out"]),
    guests: text(["guests"]),
  };

  // What the filter panel's inputs show (strings only, even when invalid).
  const drawer = {
    minPrice: text(["minPrice"]),
    maxPrice: text(["maxPrice"]),
    bedrooms: text(["bedrooms"]),
  };

  // The search service's names for the filters that were valid.
  const searchParams = {};
  for (const [name, value] of Object.entries(serviceValue))
    searchParams[name] = value;

  return {
    state,
    form,
    drawer,
    errors,
    searchParams,
    stay: stay.checkIn
      ? { checkIn: stay.checkIn, checkOut: stay.checkOut, flexDays }
      : null,
    page: state.page ?? 1,
  };
}

module.exports = { parseListingQuery, SORTS, MAX_PAGE, FLEX_DAYS };
