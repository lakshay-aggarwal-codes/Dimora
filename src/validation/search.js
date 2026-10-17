// Search parameters (P05-T01): what a visitor may ask for. Everything is
// coerced to a plain string, number or boolean; an object or a list where a
// single value belongs is refused, so `?guests[$gt]=1` or `?guests=1&guests=9`
// can never reach the database as an operator. Unknown names are dropped.
const Joi = require("joi");
const {
  PROPERTY_TYPE_VALUES,
  ROOM_TYPE_VALUES,
  AMENITY_VALUES,
} = require("../config/constants");

const MAX_RUPEES = 1000000;

const text = (label, max) =>
  Joi.string()
    .trim()
    .max(max)
    .allow("")
    .label(label)
    .messages({ "string.max": `${label} must be at most ${max} characters.` });

const oneOrMany = (values, label) =>
  Joi.array()
    .single()
    .items(Joi.string().valid(...values))
    .unique()
    .max(values.length)
    .label(label)
    .messages({
      "any.only": `${label} is not one of the choices.`,
      "array.includes": `${label} is not one of the choices.`,
    });

const searchSchema = Joi.object({
  destination: text("Destination", 100),
  keywords: text("Keywords", 100),
  minPrice: Joi.number().empty("").min(0).max(MAX_RUPEES).label("Minimum price"),
  maxPrice: Joi.number().empty("").min(0).max(MAX_RUPEES).label("Maximum price"),
  guests: Joi.number().empty("").integer().min(1).max(16).label("Guests"),
  bedrooms: Joi.number().empty("").integer().min(0).max(50).label("Bedrooms"),
  propertyType: oneOrMany(PROPERTY_TYPE_VALUES, "Property type"),
  roomType: oneOrMany(ROOM_TYPE_VALUES, "Room type"),
  amenities: oneOrMany(AMENITY_VALUES, "Amenities"),
  instantBook: Joi.boolean().truthy("1", "true", "on").falsy("0", "false", "off", ""),
})
  .custom((value, helpers) => {
    if (
      value.minPrice !== undefined &&
      value.maxPrice !== undefined &&
      value.minPrice > value.maxPrice
    ) {
      return helpers.error("price.order");
    }
    return value;
  })
  .messages({ "price.order": "The minimum price cannot be more than the maximum." });

const KNOWN = [
  "destination",
  "keywords",
  "minPrice",
  "maxPrice",
  "guests",
  "bedrooms",
  "propertyType",
  "roomType",
  "amenities",
  "instantBook",
];

/**
 * @param {object} query req.query (or any plain object)
 * @returns {{ value: object, errors: Record<string,string> }} `value` holds the
 * valid, coerced parameters; `errors` the problems by name. Valid parameters
 * are returned even when others failed, so a page can still search with what
 * was understood and say what was not.
 */
function parseSearchParams(query) {
  const input = query && typeof query === "object" ? query : {};
  const { error, value } = searchSchema.validate(input, {
    abortEarly: false,
    stripUnknown: true,
    errors: { wrap: { label: false } },
  });
  if (!error) return { value: compact(value), errors: {} };

  const errors = {};
  const bad = new Set();
  for (const detail of error.details) {
    const field = detail.path[0] ?? "maxPrice";
    bad.add(field);
    if (!errors[field]) errors[field] = detail.message;
  }
  // Keep the parameters that were fine.
  const kept = {};
  for (const key of KNOWN) {
    if (bad.has(key) || !Object.hasOwn(input, key)) continue;
    const original = input[key];
    const single = searchSchema.extract(key);
    const { error: oneError, value: oneValue } = single.validate(original);
    if (!oneError) kept[key] = oneValue;
  }
  return { value: compact(kept), errors };
}

/** Drops empty strings so "destination=" means "no destination". */
function compact(value) {
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === "" || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[key] = v;
  }
  return out;
}

module.exports = { parseSearchParams, searchSchema, MAX_RUPEES };
