// P19-T03: TRUST_PROXY_HOPS.
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

test("TRUST_PROXY_HOPS defaults to 1", () => {
  assert.equal(validateEnv(BASE).trustProxyHops, 1);
});

test("TRUST_PROXY_HOPS accepts 1 to 5 and reads it as a number", () => {
  assert.equal(validateEnv({ ...BASE, TRUST_PROXY_HOPS: "3" }).trustProxyHops, 3);
  assert.equal(validateEnv({ ...BASE, TRUST_PROXY_HOPS: "5" }).trustProxyHops, 5);
});

test("an empty TRUST_PROXY_HOPS (as in a copied .env.example) means the default", () => {
  assert.equal(validateEnv({ ...BASE, TRUST_PROXY_HOPS: "" }).trustProxyHops, 1);
});

test("0, 6, negative and non-numeric values are refused", () => {
  for (const bad of ["0", "6", "-1", "two", "1.5", "true"]) {
    assert.throws(
      () => validateEnv({ ...BASE, TRUST_PROXY_HOPS: bad }),
      EnvValidationError,
      `TRUST_PROXY_HOPS=${bad}`,
    );
  }
});
