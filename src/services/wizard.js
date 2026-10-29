// The listing wizard (P04-T02): the six steps, how a draft's stored data maps to
// each step's form, and which steps are finished.
//
// A step is finished when the host has saved it (listing.wizardSteps) AND what
// is stored for it still passes that step's validation, so removing the last
// photo, say, makes the photos step unfinished again. Steps 1-5 collect data;
// step 6 is the review. You can open step N only when steps 1..N-1 are finished.
const { validateStep } = require("../validation/wizard");
const { galleryOf } = require("./images");
const { rupeesToMinor, minorToRupees } = require("../utils/listingFields");
const { seasonFormValues } = require("../utils/priceRules");

const STEPS = Object.freeze([
  { n: 1, key: "basics", title: "The basics" },
  { n: 2, key: "location", title: "Location" },
  { n: 3, key: "details", title: "Rooms and amenities" },
  { n: 4, key: "photos", title: "Photos" },
  { n: 5, key: "pricing", title: "Price and rules" },
  { n: 6, key: "review", title: "Review and publish" },
]);
const DATA_STEPS = [1, 2, 3, 5];
const LAST_DATA_STEP = 5;
const REVIEW_STEP = 6;

const stepByNumber = (n) => STEPS.find((step) => step.n === n);

/** "1".."6" (as in a URL) -> 1..6, or null for anything else. */
function parseStep(value) {
  return /^[1-6]$/.test(String(value)) ? Number(value) : null;
}

const get = (listing, path, fallback = "") => {
  const value = listing.get ? listing.get(path) : undefined;
  return value === undefined || value === null ? fallback : value;
};

/** The form values for a step, from what is stored. */
function formValues(listing, n) {
  switch (n) {
    case 1:
      return {
        title: get(listing, "title"),
        description: get(listing, "description"),
        propertyType: get(listing, "propertyType"),
        roomType: get(listing, "roomType"),
        vibe: get(listing, "vibe"),
      };
    case 2:
      return {
        line1: get(listing, "address.line1"),
        city: get(listing, "address.city"),
        state: get(listing, "address.state"),
        country: get(listing, "address.country"),
        postalCode: get(listing, "address.postalCode"),
      };
    case 3:
      return {
        guests: get(listing, "capacity.guests"),
        bedrooms: get(listing, "capacity.bedrooms"),
        beds: get(listing, "capacity.beds"),
        bathrooms: get(listing, "capacity.bathrooms"),
        amenities: [...(listing.amenities || [])],
      };
    case 5: {
      const nightlyMinor = listing.get("pricing.nightlyMinor");
      const nightly = minorToRupees(nightlyMinor);
      const cleaning = minorToRupees(listing.get("pricing.cleaningFeeMinor"));
      return {
        price: nightly === null ? "" : nightly,
        cleaningFee: cleaning === null ? 0 : cleaning,
        minNights: get(listing, "minNights"),
        maxNights: get(listing, "maxNights"),
        advanceNoticeHours: get(listing, "advanceNoticeHours"),
        sameDayCutoffTime: get(listing, "sameDayCutoffTime"),
        checkInTime: get(listing, "checkInTime"),
        checkOutTime: get(listing, "checkOutTime"),
        cancellationPolicy: get(listing, "cancellationPolicy"),
        instantBook: Boolean(listing.instantBook),
        houseRules: get(listing, "houseRules"),
        noSpecialRules: Boolean(listing.noSpecialRules),
        ...priceRuleValues(listing, nightlyMinor),
      };
    }
    default:
      return {};
  }
}

/** The price-rule form values (P08-T04). An older absolute weekend price shows as its percentage. */
function priceRuleValues(listing, nightlyMinor) {
  const bps = listing.get("pricing.weekendBps");
  const absolute = listing.get("pricing.weekendNightlyMinor");
  let weekendPercent = 0;
  if (Number.isInteger(bps)) weekendPercent = Math.round(bps / 100);
  else if (Number.isInteger(absolute) && Number.isInteger(nightlyMinor) && nightlyMinor > 0 && absolute > nightlyMinor) {
    weekendPercent = Math.min(100, Math.round(((absolute - nightlyMinor) / nightlyMinor) * 100));
  }
  const weekly = listing.get("pricing.discounts.weeklyBps");
  const monthly = listing.get("pricing.discounts.monthlyBps");
  return {
    weekendPercent,
    weeklyDiscountPercent: Number.isInteger(weekly) ? Math.round(weekly / 100) : 0,
    monthlyDiscountPercent: Number.isInteger(monthly) ? Math.round(monthly / 100) : 0,
    ...seasonFormValues(listing.get("pricing.seasonalRates")),
  };
}

const hasPoint = (listing) => {
  const coordinates = listing.get("geometry.coordinates");
  return Array.isArray(coordinates) && coordinates.length === 2;
};

function isStepComplete(listing, n) {
  if (n === REVIEW_STEP) {
    return DATA_STEPS.concat(4).every((step) => isStepComplete(listing, step));
  }
  if (!(listing.wizardSteps || []).includes(n)) return false;
  if (n === 4) return galleryOf(listing).length >= 1;
  if (n === 2 && !hasPoint(listing)) return false;
  return (
    Object.keys(validateStep(n, formValues(listing, n)).errors).length === 0
  );
}

/** The steps for the stepper: { n, key, title, complete, reachable }. */
function stepStatuses(listing) {
  let blocked = false;
  return STEPS.map((step) => {
    const complete = isStepComplete(listing, step.n);
    const reachable = !blocked;
    if (!complete) blocked = true;
    return { ...step, complete, reachable };
  });
}

/** The step the host should open next: the first unfinished one, else the review. */
function firstIncompleteStep(listing) {
  for (let n = 1; n <= LAST_DATA_STEP; n += 1) {
    if (!isStepComplete(listing, n)) return n;
  }
  return REVIEW_STEP;
}

function canOpenStep(listing, n) {
  for (let earlier = 1; earlier < n; earlier += 1) {
    if (!isStepComplete(listing, earlier)) return false;
  }
  return true;
}

function markStepDone(listing, n) {
  const done = new Set(listing.wizardSteps || []);
  done.add(n);
  listing.wizardSteps = [...done].sort((a, b) => a - b);
}

/**
 * Copies a validated step's values onto the listing (does not save).
 * `geometry` is the looked-up point for step 2.
 */
function applyStep(listing, n, value, { geometry } = {}) {
  switch (n) {
    case 1:
      listing.set({
        title: value.title,
        description: value.description,
        propertyType: value.propertyType,
        roomType: value.roomType,
        // An empty choice clears the setting.
        vibe: value.vibe || undefined,
      });
      break;
    case 2:
      listing.set({
        address: {
          line1: value.line1,
          city: value.city,
          state: value.state || undefined,
          country: value.country,
          postalCode: value.postalCode || undefined,
        },
        // The older pages still show these two text fields: city and state only,
        // never the street address.
        location: [value.city, value.state].filter(Boolean).join(", "),
        country: value.country,
        needsReview: false,
      });
      if (geometry) listing.set("geometry", geometry);
      break;
    case 3:
      listing.set({
        "capacity.guests": value.guests,
        "capacity.bedrooms": value.bedrooms,
        "capacity.beds": value.beds,
        "capacity.bathrooms": value.bathrooms,
        amenities: value.amenities,
      });
      break;
    case 5:
      listing.set({
        "pricing.nightlyMinor": rupeesToMinor(value.price),
        "pricing.cleaningFeeMinor": rupeesToMinor(value.cleaningFee) ?? 0,
        "pricing.currency": "INR",
        // Price rules (P08-T04). An older absolute weekend price is replaced by
        // the percentage the form showed for it.
        "pricing.weekendBps": value.weekendPercent > 0 ? value.weekendPercent * 100 : undefined,
        "pricing.weekendNightlyMinor": undefined,
        "pricing.discounts.weeklyBps": value.weeklyDiscountPercent > 0 ? value.weeklyDiscountPercent * 100 : undefined,
        "pricing.discounts.monthlyBps": value.monthlyDiscountPercent > 0 ? value.monthlyDiscountPercent * 100 : undefined,
        "pricing.seasonalRates": value.seasons && value.seasons.length > 0 ? value.seasons : undefined,
        minNights: value.minNights,
        maxNights: value.maxNights,
        advanceNoticeHours: value.advanceNoticeHours,
        sameDayCutoffTime: value.sameDayCutoffTime,
        checkInTime: value.checkInTime,
        checkOutTime: value.checkOutTime,
        cancellationPolicy: value.cancellationPolicy,
        instantBook: value.instantBook,
        houseRules: value.houseRules || undefined,
        // written rules replace the "none" confirmation
        noSpecialRules: value.houseRules ? false : value.noSpecialRules,
      });
      break;
    default:
      throw new Error(`Step ${n} has no data to apply`);
  }
}

/** The text sent to the geocoder (the whole address) for step 2 values. */
function addressQuery(value) {
  return [value.line1, value.city, value.state, value.postalCode]
    .filter(Boolean)
    .join(", ");
}

/** True when the stored address differs from the submitted one (or has no point). */
function addressChanged(listing, value) {
  const now = formValues(listing, 2);
  return (
    !hasPoint(listing) ||
    ["line1", "city", "state", "country", "postalCode"].some(
      (key) =>
        String(now[key] ?? "").trim() !== String(value[key] ?? "").trim(),
    )
  );
}

module.exports = {
  STEPS,
  DATA_STEPS,
  LAST_DATA_STEP,
  REVIEW_STEP,
  stepByNumber,
  parseStep,
  formValues,
  isStepComplete,
  stepStatuses,
  firstIncompleteStep,
  canOpenStep,
  markStepDone,
  applyStep,
  addressQuery,
  addressChanged,
};
