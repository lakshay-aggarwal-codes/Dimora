// Host Readiness Checklist (P04-T05). One pure function decides whether a
// listing may go public; the checklist the host sees AND the publish action
// both call it, so the page can never say "ready" while the server refuses.
//
// It checks that things are PRESENT, not that they are good: a 200-character
// description of nonsense passes. The score is "how many of these items are
// done", not a quality rating.
const {
  CANCELLATION_POLICY_VALUES,
  READINESS,
} = require("../config/constants");

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isInt = (value) => Number.isInteger(value);

function hasPoint(listing) {
  const c = listing.geometry && listing.geometry.coordinates;
  return (
    Array.isArray(c) && c.length >= 2 && c.slice(0, 2).every(Number.isFinite)
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * @param {object} listing  a Listing document or a plain object
 * @param {object} [options]
 * @param {number} [options.minPhotos]            default 5
 * @param {number} [options.minDescriptionChars]  default 200
 * @returns {{
 *   score: number,
 *   canPublish: boolean,
 *   checks: Array<{ key: string, label: string, passed: boolean, hint: string, step: number }>
 * }}
 *   `step` is the wizard step where the host fixes the item; `hint` is empty
 *   once the check has passed.
 */
function evaluateReadiness(listing, options = {}) {
  const minPhotos = options.minPhotos ?? READINESS.minPhotos;
  const minChars = options.minDescriptionChars ?? READINESS.minDescriptionChars;
  const l = listing || {};

  const photoCount = (Array.isArray(l.images) ? l.images : []).filter(
    (image) => image && image.url,
  ).length;
  const descriptionLength = text(l.description).length;
  const address = l.address || {};
  const capacity = l.capacity || {};
  const nightly = l.pricing && l.pricing.nightlyMinor;

  const addressPresent = Boolean(
    text(address.line1) && text(address.city) && text(address.country),
  );
  const addressConfirmed =
    addressPresent && hasPoint(l) && l.needsReview !== true;
  const capacitySet =
    isInt(capacity.guests) &&
    capacity.guests >= 1 &&
    isInt(capacity.beds) &&
    capacity.beds >= 1;
  const priceSet = isInt(nightly) && nightly > 0;
  const rulesDone = text(l.houseRules).length > 0 || l.noSpecialRules === true;
  const timesSet =
    TIME.test(text(l.checkInTime)) && TIME.test(text(l.checkOutTime));
  const policyChosen = CANCELLATION_POLICY_VALUES.includes(
    l.cancellationPolicy,
  );

  const checks = [
    {
      key: "photos",
      label: `At least ${plural(minPhotos, "photo")}`,
      passed: photoCount >= minPhotos,
      hint: `You have ${photoCount}. Add ${plural(Math.max(0, minPhotos - photoCount), "more photo")}.`,
      step: 4,
    },
    {
      key: "description",
      label: `A description of at least ${minChars} characters`,
      passed: descriptionLength >= minChars,
      hint: `You have written ${descriptionLength} of ${minChars} characters.`,
      step: 1,
    },
    {
      key: "address",
      label: "Address entered and found on the map",
      passed: addressConfirmed,
      hint: "Enter the street, city and country so we can find the place on the map.",
      step: 2,
    },
    {
      key: "capacity",
      label: "Guests and beds set",
      passed: capacitySet,
      hint: "Say how many guests the place sleeps and how many beds it has.",
      step: 3,
    },
    {
      key: "price",
      label: "Nightly price set",
      passed: priceSet,
      hint: "Set the price for one night.",
      step: 5,
    },
    {
      key: "rules",
      label: 'House rules written, or "no special rules" confirmed',
      passed: rulesDone,
      hint: 'Write your house rules, or tick "I have no special house rules".',
      step: 5,
    },
    {
      key: "times",
      label: "Check-in and check-out times",
      passed: timesSet,
      hint: "Give both times, like 14:00 and 11:00.",
      step: 5,
    },
    {
      key: "cancellation",
      label: "Cancellation policy chosen",
      passed: policyChosen,
      hint: "Choose how guests can cancel.",
      step: 5,
    },
  ].map((check) => ({ ...check, hint: check.passed ? "" : check.hint }));

  const passedCount = checks.filter((check) => check.passed).length;
  return {
    score: Math.round((passedCount / checks.length) * 100),
    canPublish: passedCount === checks.length,
    checks,
  };
}

module.exports = { evaluateReadiness };
