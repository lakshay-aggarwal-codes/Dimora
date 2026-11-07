// The simulated payment provider (P16-T01, ADR-009). It is the only thing
// services/payments.js asks to "move money", and it moves none: it answers
// from the outcome it is given. A real or test-mode gateway (P16-T02) would be
// another file with the same two functions.
//
// It reads ONLY an amount, a currency and an outcome. It is never given, and
// never reads, anything card-shaped.

const OUTCOMES = Object.freeze(["success", "declined", "error"]);

class PaymentServiceError extends Error {
  constructor(message = "The simulated payment service did not answer.") {
    super(message);
    this.name = "PaymentServiceError";
    this.code = "payment_service_error";
  }
}

function assertMoney(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new TypeError("amountMinor must be a whole number of minor units");
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("currency must be a three-letter code");
  }
}

/**
 * @param {{ amountMinor: number, currency: string, outcome?: string }} charge
 * @returns {Promise<{ status: "succeeded" | "failed", failureCode?: string }>}
 * @throws {PaymentServiceError} for the "error" outcome (the service is "down")
 */
async function charge({ amountMinor, currency, outcome = "success" } = {}) {
  assertMoney(amountMinor, currency);
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`unknown outcome: ${outcome}`);
  await Promise.resolve();
  if (outcome === "error") throw new PaymentServiceError();
  if (outcome === "declined") return { status: "failed", failureCode: "declined" };
  return { status: "succeeded" };
}

/**
 * @returns {Promise<{ status: "refunded_simulated" }>}
 */
async function refund({ amountMinor, currency } = {}) {
  assertMoney(amountMinor, currency);
  await Promise.resolve();
  return { status: "refunded_simulated" };
}

module.exports = { name: "simulated", charge, refund, OUTCOMES, PaymentServiceError };
