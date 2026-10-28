// P02-T05: email settings.
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
};

test("defaults: console transport, verification required", () => {
  const { email } = validateEnv(BASE);
  assert.equal(email.transport, "console");
  assert.equal(email.verificationRequired, true);
  assert.equal(email.resendApiKey, null);
});

test("EMAIL_VERIFICATION_REQUIRED=false turns the requirement off", () => {
  assert.equal(validateEnv({ ...BASE, EMAIL_VERIFICATION_REQUIRED: "false" }).email.verificationRequired, false);
  assert.equal(validateEnv({ ...BASE, EMAIL_VERIFICATION_REQUIRED: "" }).email.verificationRequired, true);
});

test("resend needs a key and a sender", () => {
  assert.throws(() => validateEnv({ ...BASE, EMAIL_TRANSPORT: "resend" }), EnvValidationError);
  assert.throws(() => validateEnv({ ...BASE, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" }), /EMAIL_FROM/);
  const ok = validateEnv({ ...BASE, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: "Dimora <a@b.example>" });
  assert.equal(ok.email.transport, "resend");
  assert.equal(ok.email.resendApiKey, "re_x");
});

test("an unknown transport is refused (no SMTP here)", () => {
  assert.throws(() => validateEnv({ ...BASE, EMAIL_TRANSPORT: "smtp" }), EnvValidationError);
});

test("production with the console transport warns, in the right words for each case", () => {
  const on = validateEnv(PROD).warnings.join("|");
  assert.match(on, /nobody can confirm an address/);
  const off = validateEnv({ ...PROD, EMAIL_VERIFICATION_REQUIRED: "false" }).warnings.join("|");
  assert.match(off, /no email is delivered/);
  assert.doesNotMatch(off, /nobody can confirm/);
});
