// Money for display (P03-T03). Amounts are integers in MINOR units (paise for
// INR): never floats, never strings. Prices in the database move to paise in
// P04-T01/P08-T01, which will add the arithmetic helpers to this module.
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

module.exports = { formatMoney };
