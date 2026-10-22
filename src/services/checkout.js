// The checkout page's view model (P08-T03). It never prices anything itself:
// the lines and the total are exactly what services/pricing.js returned
// (through quoteService.getQuote), so the total the guest confirms is the
// total reservations.create stores (Signature #1). The only things added here
// are words for the lines and the comparison with the price the guest saw
// before (display only: it cannot change what is charged, because
// reservations.create compares the real price with `expectedTotalMinor`).
const { formatMoney } = require("../utils/money");
const { parseDateOnly } = require("../utils/dates");
const { CANCELLATION_POLICIES } = require("../config/constants");
const { cancellationText } = require("../config/cancellationText");

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const dayFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-12-01" -> "Tue, 1 Dec 2026" (date-only values are UTC midnight). */
const dayLabel = (iso) => dayFormat.format(parseDateOnly(iso));

/** The words for one breakdown line (the pricing service sends code + numbers). */
function lineLabel(line, currency) {
  switch (line.code) {
    case "nights":
      return `${formatMoney(line.unitMinor, currency)} × ${plural(line.quantity, "night", "nights")}`;
    case "weekend_nights":
      return `${formatMoney(line.unitMinor, currency)} × ${plural(line.quantity, "weekend night", "weekend nights")}`;
    case "cleaning":
      return "Cleaning fee";
    case "service_fee":
      return "Service fee";
    case "tax":
      return line.included ? "Taxes (included in the price)" : "Taxes";
    default:
      return "Other charges";
  }
}

// The lines of the quote the guest saw, carried in a hidden field only so the
// page can highlight what changed. Strict format "code:amount;code:amount";
// anything else is ignored. It is display only and never used for a price.
const PREVIOUS_LINE = /^[a-z_]{1,30}:\d{1,15}$/;

function encodeLines(quote) {
  return quote.lines
    .map((line) => `${line.code}:${line.amountMinor}`)
    .join(";");
}

function decodeLines(value) {
  const found = new Map();
  if (typeof value !== "string" || value.length > 400) return found;
  for (const part of value.split(";")) {
    if (!PREVIOUS_LINE.test(part)) continue;
    const [code, amount] = part.split(":");
    found.set(code, Number(amount));
  }
  return found;
}

function coverOf(listing) {
  return (
    (Array.isArray(listing.images) &&
      listing.images[0] &&
      listing.images[0].url) ||
    (listing.image && listing.image.url) ||
    ""
  );
}

/**
 * @param {object} listing  the listing document
 * @param {object} payload  what quoteService.getQuote returned (bookable: true)
 * @param {object} [options]
 * @param {number|null} [options.previousTotalMinor]  the total the guest confirmed before
 * @param {string} [options.previousLines]            encoded lines of that quote
 * @param {string} options.idempotencyKey
 */
function buildCheckoutView(
  listing,
  payload,
  { previousTotalMinor = null, previousLines = "", idempotencyKey } = {},
) {
  const { quote } = payload;
  const before = decodeLines(previousLines);
  const changed =
    previousTotalMinor !== null && previousTotalMinor !== quote.totalMinor;
  const lines = quote.lines.map((line) => ({
    code: line.code,
    label: lineLabel(line, quote.currency),
    amountMinor: line.amountMinor,
    included: Boolean(line.included),
    // A line is highlighted when it is new or its amount differs from what was shown.
    changed:
      changed && before.size > 0 && before.get(line.code) !== line.amountMinor,
  }));
  const policyValue = listing.cancellationPolicy;
  const policy = CANCELLATION_POLICIES.find((p) => p.value === policyValue);
  const houseRules =
    typeof listing.houseRules === "string" ? listing.houseRules.trim() : "";

  return {
    listing: {
      id: String(listing._id),
      title: listing.title,
      place: [listing.address && listing.address.city, listing.country]
        .filter(Boolean)
        .join(", "),
      coverUrl: coverOf(listing),
      checkInTime: listing.checkInTime || "",
      checkOutTime: listing.checkOutTime || "",
      houseRules,
      noSpecialRules: Boolean(listing.noSpecialRules),
    },
    stay: {
      in: payload.in,
      out: payload.out,
      inLabel: dayLabel(payload.in),
      outLabel: dayLabel(payload.out),
      nights: quote.nights,
      guests: payload.guests,
      guestsLabel: plural(payload.guests, "guest", "guests"),
    },
    currency: quote.currency,
    lines,
    totalMinor: quote.totalMinor,
    taxIncluded: Boolean(quote.taxIncluded),
    expectedTotalMinor: payload.expectedTotalMinor,
    encodedLines: encodeLines(quote),
    instant: Boolean(listing.instantBook),
    policy: {
      value: policy ? policy.value : "",
      label: policy ? policy.label : "Not stated",
      text: cancellationText(policyValue),
    },
    idempotencyKey,
    change: changed
      ? {
          previousTotalMinor,
          newTotalMinor: quote.totalMinor,
          differenceMinor: quote.totalMinor - previousTotalMinor,
        }
      : null,
  };
}

module.exports = {
  buildCheckoutView,
  lineLabel,
  dayLabel,
  encodeLines,
  decodeLines,
};
