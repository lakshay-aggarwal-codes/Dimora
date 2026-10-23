// Cancellation policies as DATA (P09-T03). src/services/refunds.js reads this
// and nothing else to decide a refund, so a rule is changed here, in one place.
//
// The sentences guests read (checkout page, booking page) are
// CANCELLATION_TERMS in src/config/constants.js. They describe exactly the
// rules below; change both together (tests/unit/refunds.test.js checks the
// numbers the sentences promise).
//
// Vocabulary
//   checkInAt   check-in date at the listing's check-in time, on the clock of
//               the listing's time zone ("00:00" when the listing gives none)
//   total       what the guest was quoted (pricingSnapshot.totalMinor)
//   firstNight  one night's average price (pricingSnapshot.avgPerNightMinor)
//   rest        the nights' price (pricingSnapshot.subtotalMinor) minus firstNight
//
// Rules are tried in order; the first whose `when` holds decides. `keep` says
// what the host keeps (everything else is refunded): "nothing", the first
// night plus a share of the rest (rounded up, so a part-paise goes to the
// host), "everything", or `refundShareOfTotal` (the guest gets that share of
// the total back, rounded down).
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const POLICIES = Object.freeze({
  // Free until 24 hours before check-in; then the first night is kept.
  flexible: Object.freeze([
    Object.freeze({
      id: "flexible_free",
      when: { freeUntilHoursBeforeCheckIn: 24 },
      keep: { kind: "nothing" },
    }),
    Object.freeze({
      id: "flexible_late",
      when: { before: "checkIn" },
      keep: { kind: "firstNight", restShare: 0 },
    }),
  ]),
  // Free until 5 days before check-in; then the first night and half the rest.
  moderate: Object.freeze([
    Object.freeze({
      id: "moderate_free",
      when: { freeUntilHoursBeforeCheckIn: 5 * 24 },
      keep: { kind: "nothing" },
    }),
    Object.freeze({
      id: "moderate_late",
      when: { before: "checkIn" },
      keep: { kind: "firstNight", restShare: 0.5 },
    }),
  ]),
  // Free within 48 h of booking when check-in is 14+ days away; half back until
  // 7 days before check-in; nothing after.
  strict: Object.freeze([
    Object.freeze({
      id: "strict_grace",
      when: { withinHoursOfBooking: 48, minHoursBeforeCheckIn: 14 * 24 },
      keep: { kind: "nothing" },
    }),
    Object.freeze({
      id: "strict_half",
      when: { freeUntilHoursBeforeCheckIn: 7 * 24 },
      keep: { kind: "refundShareOfTotal", share: 0.5 },
    }),
    Object.freeze({
      id: "strict_none",
      when: { before: "checkIn" },
      keep: { kind: "everything" },
    }),
  ]),
});

// Short sentence per rule, shown with the refund on the booking page.
const RULE_TEXT = Object.freeze({
  host_cancelled: "The host cancelled, so you get everything back.",
  request_withdrawn: "The host had not answered yet, so cancelling is free.",
  stay_started: "The stay had already started, so nothing is refunded.",
  no_policy:
    "The listing states no cancellation policy, so no refund is promised.",
  flexible_free: "Cancelled at least 24 hours before check-in: full refund.",
  flexible_late:
    "Cancelled less than 24 hours before check-in: the first night is not refunded.",
  moderate_free: "Cancelled at least 5 days before check-in: full refund.",
  moderate_late:
    "Cancelled less than 5 days before check-in: the first night and half of the remaining nights are not refunded.",
  strict_grace:
    "Cancelled within 48 hours of booking, with check-in at least 14 days away: full refund.",
  strict_half:
    "Cancelled at least 7 days before check-in: half of the total is refunded.",
  strict_none:
    "Cancelled less than 7 days before check-in: nothing is refunded.",
});

module.exports = { POLICIES, RULE_TEXT, HOUR_MS, DAY_MS };
