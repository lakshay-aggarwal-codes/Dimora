// Runs before every test file. Tests must never depend on a developer's .env:
// the app under test is built from tests/helpers/config.js instead.
process.env.NODE_ENV = "test";
