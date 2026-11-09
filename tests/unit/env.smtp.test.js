// EMAIL_TRANSPORT=smtp settings (Gmail through the built-in SMTP client).
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
const GMAIL = {
  ...BASE,
  EMAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_USER: "dimora.test@gmail.com",
  SMTP_PASS: "abcd efgh ijkl mnop",
};
const PROD = {
  ...GMAIL,
  NODE_ENV: "production",
  SESSION_SECRET: "k8Jd92hfLq0Zx7VbN3mTr5YwUa1CeGpS4oIh6",
  APP_BASE_URL: "https://dimora.example.com",
};

test("Gmail: port 465 with TLS at once, the app password without its spaces, sent as the Gmail address", () => {
  const { email } = validateEnv(GMAIL);
  assert.equal(email.transport, "smtp");
  assert.deepEqual(email.smtp, {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: "dimora.test@gmail.com",
    pass: "abcdefghijklmnop",
  });
  assert.equal(email.from, "Dimora <dimora.test@gmail.com>");
});

test("EMAIL_FROM, when given, wins", () => {
  assert.equal(validateEnv({ ...GMAIL, EMAIL_FROM: "Dimora Stays <dimora.test@gmail.com>" }).email.from, "Dimora Stays <dimora.test@gmail.com>");
});

test("port 587 means STARTTLS (secure false) unless SMTP_SECURE says otherwise", () => {
  assert.equal(validateEnv({ ...GMAIL, SMTP_PORT: "587" }).email.smtp.secure, false);
  assert.equal(validateEnv({ ...GMAIL, SMTP_PORT: "587", SMTP_SECURE: "true" }).email.smtp.secure, true);
  assert.equal(validateEnv({ ...GMAIL, SMTP_PORT: "465", SMTP_SECURE: "false" }).email.smtp.secure, false);
});

test("another host keeps the password exactly as given", () => {
  assert.equal(validateEnv({ ...GMAIL, SMTP_HOST: "mail.example.com", SMTP_PASS: "a b c" }).email.smtp.pass, "a b c");
});

test("without the smtp transport the smtp block is empty and nothing is required", () => {
  const { email } = validateEnv(BASE);
  assert.equal(email.transport, "console");
  assert.equal(email.smtp.host, null);
  assert.equal(email.smtp.user, null);
  assert.equal(email.smtp.pass, null);
});

test("smtp needs a host, a user and a password; each missing one is named", () => {
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
    const env = { ...GMAIL };
    delete env[key];
    assert.throws(() => validateEnv(env), (err) => err instanceof EnvValidationError && new RegExp(`${key} is missing`).test(err.message), key);
  }
});

test("a user name that is not an address needs EMAIL_FROM", () => {
  assert.throws(() => validateEnv({ ...GMAIL, SMTP_USER: "apikey" }), EnvValidationError);
  assert.equal(validateEnv({ ...GMAIL, SMTP_USER: "apikey", EMAIL_FROM: "Dimora <hello@example.com>" }).email.from, "Dimora <hello@example.com>");
});

test("the port is a number from 1 to 65535", () => {
  for (const bad of ["0", "70000", "gmail"]) {
    assert.throws(() => validateEnv({ ...GMAIL, SMTP_PORT: bad }), EnvValidationError, bad);
  }
});

test("a warning in production (some hosts block SMTP), none in development", () => {
  assert.equal(validateEnv(GMAIL).warnings.some((w) => /smtp/i.test(w)), false);
  assert.equal(validateEnv(PROD).warnings.some((w) => /EMAIL_TRANSPORT=smtp in production/.test(w)), true);
});

test("the password never appears in an error message", () => {
  const env = { ...GMAIL, SMTP_PORT: "nope" };
  assert.throws(() => validateEnv(env), (err) => !err.message.includes("abcd efgh"));
});
