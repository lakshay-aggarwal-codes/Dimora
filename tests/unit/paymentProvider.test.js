// P16-T01: the simulated provider answers from the outcome it is given and
// moves nothing. It accepts only an amount, a currency and an outcome.
const provider = require("../../src/services/paymentProviders/simulated");

describe("charge", () => {
  test("succeeds by default", async () => {
    expect(await provider.charge({ amountMinor: 1000, currency: "INR" })).toEqual({ status: "succeeded" });
  });
  test("a declined outcome fails with the code 'declined'", async () => {
    expect(await provider.charge({ amountMinor: 1000, currency: "INR", outcome: "declined" })).toEqual({
      status: "failed",
      failureCode: "declined",
    });
  });
  test("the error outcome throws a PaymentServiceError the service understands", async () => {
    await expect(provider.charge({ amountMinor: 1000, currency: "INR", outcome: "error" })).rejects.toMatchObject({
      name: "PaymentServiceError",
      code: "payment_service_error",
    });
  });
  test("refuses nonsense: a fraction, a negative, a bad currency, an unknown outcome", async () => {
    for (const bad of [
      { amountMinor: 10.5, currency: "INR" },
      { amountMinor: -1, currency: "INR" },
      { amountMinor: "1000", currency: "INR" },
      { amountMinor: 1000, currency: "rupees" },
      { amountMinor: 1000, currency: "INR", outcome: "free-money" },
      undefined,
    ]) {
      await expect(provider.charge(bad)).rejects.toBeInstanceOf(TypeError);
    }
  });
  test("an unknown outcome list is exactly success, declined, error", () => {
    expect([...provider.OUTCOMES]).toEqual(["success", "declined", "error"]);
  });
});

describe("refund", () => {
  test("answers refunded_simulated", async () => {
    expect(await provider.refund({ amountMinor: 500, currency: "INR" })).toEqual({ status: "refunded_simulated" });
  });
  test("refuses a fraction of a paisa", async () => {
    await expect(provider.refund({ amountMinor: 0.5, currency: "INR" })).rejects.toBeInstanceOf(TypeError);
  });
});
