// What a guest is told about a listing's cancellation policy (checkout page,
// P08-T03; booking page, P09-T01). There is ONE set of sentences:
// CANCELLATION_TERMS in src/config/constants.js, which describes the refund
// rules in src/config/cancellation.js that P09-T03 applies. This file only
// adds the sentence for a listing that states no policy.
const { CANCELLATION_TERMS } = require("./constants");

const POLICY_TEXT = CANCELLATION_TERMS;

const NO_POLICY_TEXT =
  "This listing does not state a cancellation policy, so no refund is promised.";

/** The sentence for a policy value (undefined or unknown -> the no-policy sentence). */
function cancellationText(value) {
  return Object.hasOwn(POLICY_TEXT, value)
    ? POLICY_TEXT[value]
    : NO_POLICY_TEXT;
}

module.exports = { POLICY_TEXT, NO_POLICY_TEXT, cancellationText };
