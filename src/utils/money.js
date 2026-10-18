// Money (P03-T03 display, P08-T01 arithmetic). Amounts are integers in MINOR
// units (paise for INR): never floats, never strings (ADR-002).
const formatters = new Map();

function formatterFor(currency, fractionDigits) {
  const key = `${currency}:${fractionDigits}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, fmt);
  }
  return fmt;
}

/**
 * formatMoney(123456)        -> "₹1,234.56"
 * formatMoney(120000)        -> "₹1,200"      (whole amounts drop the .00)
 * formatMoney(null)          -> "N/A"          (no price set)
 * formatMoney(1050, "USD")   -> "$10.50"
 * Throws TypeError for anything that is not an integer amount (a float here
 * is a bug, and showing a rounded price would hide it).
 */
function formatMoney(minor, currency = "INR") {
  if (minor === null || minor === undefined) return "N/A";
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) {
    throw new TypeError("formatMoney expects an integer amount in minor units");
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError(
      "formatMoney expects a 3-letter currency code such as INR",
    );
  }
  const digits = formatterFor(currency, undefined).resolvedOptions()
    .maximumFractionDigits;
  const divisor = 10 ** digits;
  const whole = minor % divisor === 0;
  return formatterFor(currency, whole ? 0 : digits).format(minor / divisor);
}

// ---------------------------------------------------------------------------
// Arithmetic (P08-T01). Everything here works on integers in minor units and
// never touches a float. Intermediate products can exceed 2^53, so they are
// computed with BigInt and converted back (with a check) only at the end.
//
// ROUNDING RULE (the only one in the app): a fraction of a paisa is rounded
// half up, i.e. 0.5 paisa and above goes up, below goes down. Amounts are never
// negative here, so "up" means away from zero too.
//   percentOf(1, 5000)   (50% of 1 paisa)  -> 1
//   percentOf(1, 4999)   (49.99%)          -> 0
//   percentOf(999, 1800) (18% of 9.99)     -> 180   (179.82 rounds to 180)
// ---------------------------------------------------------------------------

const MAX_BPS = 10000; // 100 %

/** Throws TypeError unless `value` is a non-negative safe integer. */
function assertMinor(value, name = "amount") {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer in minor units`);
  }
  return value;
}

function toSafe(big, name) {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${name} is too large`);
  }
  return n;
}

/** round-half-up of amount * numerator / denominator, all integers, exactly. */
function mulDivRound(amount, numerator, denominator) {
  assertMinor(amount, "amount");
  assertMinor(numerator, "numerator");
  if (typeof denominator !== "number" || !Number.isSafeInteger(denominator) || denominator < 1) {
    throw new TypeError("denominator must be a positive integer");
  }
  const d = BigInt(denominator);
  const exact = BigInt(amount) * BigInt(numerator);
  return toSafe((exact * 2n + d) / (2n * d), "result");
}

/**
 * `basisPoints` hundredths of a percent of `amount`: 1800 = 18 %, 250 = 2.5 %.
 * Basis points keep rates as integers too.
 */
function percentOf(amount, basisPoints) {
  assertMinor(amount, "amount");
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > MAX_BPS) {
    throw new TypeError(`basisPoints must be an integer from 0 to ${MAX_BPS}`);
  }
  return mulDivRound(amount, basisPoints, MAX_BPS);
}

/** amount / divisor, rounded half up (the average of an integer total). */
function divideRound(amount, divisor) {
  return mulDivRound(amount, 1, divisor);
}

/** amount x count (a whole number of nights, say), checked for overflow. */
function multiplyMinor(amount, count) {
  assertMinor(amount, "amount");
  assertMinor(count, "count");
  return toSafe(BigInt(amount) * BigInt(count), "result");
}

/** Sum of amounts, checked for overflow. An empty list is 0. */
function sumMinor(amounts) {
  if (!Array.isArray(amounts)) throw new TypeError("sumMinor expects an array");
  let total = 0n;
  for (const amount of amounts) total += BigInt(assertMinor(amount, "amount"));
  return toSafe(total, "sum");
}

module.exports = {
  formatMoney,
  assertMinor,
  percentOf,
  divideRound,
  mulDivRound,
  multiplyMinor,
  sumMinor,
  MAX_BPS,
};
