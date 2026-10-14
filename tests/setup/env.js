// Runs before every test file. Tests must never depend on a developer's .env:
// they get fixed, fake values here (never real credentials), and the app under
// test is normally built from tests/helpers/config.js.
process.env.NODE_ENV = "test";

const FAKE_ENV = {
  MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
  SESSION_SECRET: "test-session-secret-not-for-production",
  CLOUDINARY_CLOUD_NAME: "test",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "secret",
  MAPBOX_SERVER_TOKEN: "pk.test-server",
  MAPBOX_PUBLIC_TOKEN: "pk.test-public",
};
for (const [name, value] of Object.entries(FAKE_ENV)) {
  process.env[name] = value;
}
