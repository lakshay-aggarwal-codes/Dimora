// P16-T01: the simulated payment settings.
const assert = require("node:assert/strict");
const { validateEnv, EnvValidationError } = require("../../src/config/env");

const BASE = {
  NODE_ENV: "development",
  MONGODB_URI: "mongodb://127.0.0.1:27017/dimora",
  SESSION_SECRET: "dev-secret-not-for-production",
  CLOUDINARY_CLOUD_NAME: "cloud",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "api-secret-value",
  MAPBOX_SERVER_TOKEN: "pk.server",
  MAPBOX_PUBLIC_TOKEN: "pk.public",
};
const PROD = {
  ...BASE,
  NODE_ENV: "production",
  SESSION_SECRET: "k8Jd92hfLq0Zx7VbN3mTr5YwUa1CeGpS4oIh6",
  APP_BASE_URL: "https://dimora.example.com",
  EMAIL_VERIFICATION_REQUIRED: "false",
};

test("defaults: the step is on, no outcome selector, a 15-minute hold", () => {
  assert.deepEqual(validateEnv(BASE).payments, {
    simulated: true,
    outcomeSelector: false,
    holdMinutes: 15,
  });
});

test("empty values (a copied .env.example) mean the defaults", () => {
  const { payments } = validateEnv({
    ...BASE,
    SIMULATED_PAYMENTS: "",
    SIMULATED_PAYMENT_OUTCOMES: "",
    PAYMENT_HOLD_MINUTES: "",
  });
  assert.deepEqual(payments, { simulated: true, outcomeSelector: false, holdMinutes: 15 });
});

test("SIMULATED_PAYMENTS=false books directly, as before the step existed", () => {
  assert.equal(validateEnv({ ...BASE, SIMULATED_PAYMENTS: "false" }).payments.simulated, false);
});

test("SIMULATED_PAYMENT_OUTCOMES=true shows the selector; a warning in production, none in development", () => {
  assert.equal(validateEnv({ ...BASE, SIMULATED_PAYMENT_OUTCOMES: "true" }).payments.outcomeSelector, true);
  assert.equal(
    validateEnv({ ...BASE, SIMULATED_PAYMENT_OUTCOMES: "true" }).warnings.some((w) => /SIMULATED_PAYMENT_OUTCOMES/.test(w)),
    false,
  );
  const prod = validateEnv({ ...PROD, SIMULATED_PAYMENT_OUTCOMES: "true" });
  assert.equal(prod.warnings.some((w) => /SIMULATED_PAYMENT_OUTCOMES/.test(w)), true);
  assert.equal(validateEnv(PROD).warnings.some((w) => /SIMULATED_PAYMENT_OUTCOMES/.test(w)), false);
});

test("PAYMENT_HOLD_MINUTES is a whole number from 1 to 60", () => {
  assert.equal(validateEnv({ ...BASE, PAYMENT_HOLD_MINUTES: "30" }).payments.holdMinutes, 30);
  for (const bad of ["0", "61", "1.5", "soon"]) {
    assert.throws(() => validateEnv({ ...BASE, PAYMENT_HOLD_MINUTES: bad }), EnvValidationError, bad);
  }
});

test("the payment settings are frozen", () => {
  assert.equal(Object.isFrozen(validateEnv(BASE).payments), true);
});
