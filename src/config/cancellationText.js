// What a guest is told about a listing's cancellation policy on the checkout
// page (P08-T03). These are DESCRIPTIONS only. The refund calculation, with
// the exact cut-off instants in the listing's time zone, is P09-T03
// (`refundFor`); it must implement exactly the rules written here (or change
// them here at the same time), because this is what the guest read before
// booking.
const POLICY_TEXT = Object.freeze({
  flexible:
    "Free cancellation until 24 hours before check-in. After that, the stay is not refunded.",
  moderate:
    "Full refund until 5 days before check-in. From then until 24 hours before check-in, half of the total is refunded. After that, the stay is not refunded.",
  strict:
    "Half of the total is refunded if you cancel at least 7 days before check-in. After that, the stay is not refunded.",
});

const NO_POLICY_TEXT =
  "This listing does not state a cancellation policy, so no refund is promised.";

/** The sentence for a policy value (undefined or unknown -> the no-policy sentence). */
function cancellationText(value) {
  return Object.hasOwn(POLICY_TEXT, value)
    ? POLICY_TEXT[value]
    : NO_POLICY_TEXT;
}

module.exports = { POLICY_TEXT, NO_POLICY_TEXT, cancellationText };
