// Validation for each step of the listing wizard (P04-T02). One Joi schema per
// step; the browser is never trusted, so every step is checked on the server
// every time it is saved. Field names are the form's own (flat, no listing[...]).
// Messages are written for the person filling in the form.
const Joi = require("joi");
const {
  PROPERTY_TYPE_VALUES,
  ROOM_TYPE_VALUES,
  VIBE_VALUES,
  CANCELLATION_POLICY_VALUES,
  AMENITY_VALUES,
  ACCESSIBILITY_VALUES,
} = require("../config/constants");

const { parseSeasons, SEASON_FIELD_NAMES } = require("../utils/priceRules");

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (label, { min = 1, max, required = true } = {}) => {
  let rule = Joi.string().trim().max(max).label(label);
  rule = required ? rule.min(min).required() : rule.allow("").default("");
  return rule.messages({
    "any.required": `${label} is required.`,
    "string.empty": `${label} is required.`,
    "string.min": `${label} must be at least ${min} characters.`,
    "string.max": `${label} must be at most ${max} characters.`,
  });
};

const whole = (label, min, max) =>
  Joi.number().integer().min(min).max(max).required().label(label).messages({
    "any.required": `${label} is required.`,
    "number.base": `${label} must be a number.`,
    "number.integer": `${label} must be a whole number.`,
    "number.min": `${label} must be at least ${min}.`,
    "number.max": `${label} must be at most ${max}.`,
  });

const choice = (label, values) =>
  Joi.string()
    .valid(...values)
    .required()
    .label(label)
    .messages({
      "any.required": `Choose ${label.toLowerCase()}.`,
      "string.empty": `Choose ${label.toLowerCase()}.`,
      "any.only": `Choose ${label.toLowerCase()} from the list.`,
    });

const rupees = (label, min, max, { required = true } = {}) => {
  let rule = Joi.number().min(min).max(max).label(label).messages({
    "number.base": `${label} must be a number.`,
    "number.min": `${label} must be at least ₹${min}.`,
    "number.max": `${label} must be at most ₹${max.toLocaleString("en-IN")}.`,
  });
  rule = required
    ? rule.required().messages({ "any.required": `${label} is required.` })
    : rule.empty("").default(0);
  return rule;
};

const time = (label) =>
  Joi.string()
    .trim()
    .pattern(TIME)
    .required()
    .label(label)
    .messages({
      "any.required": `${label} is required.`,
      "string.empty": `${label} is required.`,
      "string.pattern.base": `${label} must look like 14:00.`,
    });

// Optional booking-rule fields (P07-T06): a blank field means the default, so
// a form posted without them (or an older client) keeps working.
const optionalWhole = (label, min, max, fallback) =>
  Joi.number()
    .integer()
    .min(min)
    .max(max)
    .empty("")
    .default(fallback)
    .label(label)
    .messages({
      "number.base": `${label} must be a number.`,
      "number.integer": `${label} must be a whole number.`,
      "number.min": `${label} must be at least ${min}.`,
      "number.max": `${label} must be at most ${max}.`,
    });

const optionalTime = (label, fallback) =>
  Joi.string()
    .trim()
    .pattern(TIME)
    .empty("")
    .default(fallback)
    .label(label)
    .messages({ "string.pattern.base": `${label} must look like 20:00.` });

const basics = Joi.object({
  title: text("Title", { min: 5, max: 100 }),
  description: text("Description", { min: 20, max: 3000 }),
  propertyType: choice("Property type", PROPERTY_TYPE_VALUES),
  roomType: choice("What guests get", ROOM_TYPE_VALUES),
  // Optional: "" means no setting chosen.
  vibe: Joi.string()
    .valid(...VIBE_VALUES)
    .allow("")
    .label("Setting")
    .messages({ "any.only": "Choose a setting from the list." }),
});

const location = Joi.object({
  line1: text("Street address", { max: 200 }),
  city: text("City", { max: 100 }),
  state: text("State or region", { max: 100, required: false }),
  country: text("Country", { max: 100 }),
  postalCode: text("Postal code", { max: 20, required: false }),
});

const details = Joi.object({
  guests: whole("Guests", 1, 16),
  bedrooms: whole("Bedrooms", 0, 50),
  beds: whole("Beds", 0, 50),
  bathrooms: Joi.number()
    .multiple(0.5)
    .min(0)
    .max(50)
    .required()
    .label("Bathrooms")
    .messages({
      "any.required": "Bathrooms is required.",
      "number.base": "Bathrooms must be a number.",
      "number.multiple": "Bathrooms can be a whole or half number (1 or 1.5).",
      "number.min": "Bathrooms must be at least 0.",
      "number.max": "Bathrooms must be at most 50.",
    }),
  amenities: Joi.array()
    .single()
    .items(Joi.string().valid(...AMENITY_VALUES))
    .unique()
    .default([])
    .label("Amenities")
    .messages({
      "any.only": "Choose amenities from the list.",
      "array.includes": "Choose amenities from the list.",
      "array.unique": "Each amenity can be chosen once.",
    }),
  accessibility: Joi.array()
    .single()
    .items(Joi.string().valid(...ACCESSIBILITY_VALUES))
    .unique()
    .default([])
    .label("Accessibility features")
    .messages({
      "any.only": "Choose accessibility features from the list.",
      "array.includes": "Choose accessibility features from the list.",
      "array.unique": "Each accessibility feature can be chosen once.",
    }),
});

const pricing = Joi.object({
  price: rupees("Nightly price", 100, 1000000),
  cleaningFee: rupees("Cleaning fee", 0, 1000000, { required: false }),
  minNights: whole("Minimum nights", 1, 365),
  maxNights: whole("Maximum nights", 1, 365),
  advanceNoticeHours: optionalWhole("Advance notice", 0, 168, 0),
  sameDayCutoffTime: optionalTime("Same-day cut-off", "20:00"),
  checkInTime: time("Check-in time"),
  checkOutTime: time("Check-out time"),
  cancellationPolicy: choice("Cancellation policy", CANCELLATION_POLICY_VALUES),
  instantBook: Joi.boolean()
    .truthy("on", "1", "true")
    .falsy("off", "0", "false", "")
    .default(false),
  houseRules: text("House rules", { max: 2000, required: false }),
  noSpecialRules: Joi.boolean()
    .truthy("on", "1", "true")
    .falsy("off", "0", "false", "")
    .default(false),
  // Price rules (P08-T04), all optional: blank means none.
  weekendPercent: optionalWhole("Weekend increase", 0, 100, 0),
  weeklyDiscountPercent: optionalWhole("Weekly discount", 0, 50, 0),
  monthlyDiscountPercent: optionalWhole("Monthly discount", 0, 50, 0),
  // Season rows are checked together by parseSeasons (validateStep), not here.
  ...Object.fromEntries(
    SEASON_FIELD_NAMES.map((name) => [name, Joi.string().trim().allow("").max(60).default("")]),
  ),
})
  .custom((value, helpers) => {
    if (value.minNights > value.maxNights) {
      return helpers.error("nights.order");
    }
    return value;
  })
  .messages({
    "nights.order": "Minimum nights cannot be more than maximum nights.",
  });

// Checkboxes and empty fields are absent from a browser's form post. A
// submitted field that is not part of the step is refused, not ignored.
const STEP_SCHEMAS = { 1: basics, 2: location, 3: details, 5: pricing };

/**
 * @returns {{ value: object|undefined, errors: Record<string,string> }}
 * `errors` is empty when valid; its keys are field names.
 */
function validateStep(step, body) {
  const schema = STEP_SCHEMAS[step];
  if (!schema) throw new Error(`No form for step ${step}`);
  const { error, value } = schema.validate(body ?? {}, {
    abortEarly: false,
    errors: { wrap: { label: false } },
  });
  // Seasonal prices (step 5) are several boxes that must agree with each other.
  const seasonResult = step === 5 ? parseSeasons(body ?? {}) : { seasons: [], errors: {} };
  if (!error) {
    if (Object.keys(seasonResult.errors).length > 0) {
      return { value: undefined, errors: seasonResult.errors };
    }
    if (step === 5) {
      for (const name of SEASON_FIELD_NAMES) delete value[name];
      value.seasons = seasonResult.seasons;
    }
    return { value, errors: {} };
  }
  const errors = { ...seasonResult.errors };
  for (const detail of error.details) {
    // A rule about several fields has an empty path: show it by the first one.
    const field =
      detail.path[0] ?? (step === 5 ? "minNights" : String(detail.context?.label));
    if (!errors[field]) errors[field] = detail.message;
  }
  return { value: undefined, errors };
}

module.exports = { validateStep, STEP_SCHEMAS };
