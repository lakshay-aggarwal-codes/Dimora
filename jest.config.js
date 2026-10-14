// Jest configuration (P01-T08).
// Run everything:         npm test            (add -- --runInBand to run serially)
// Coverage report:        npm run test:coverage   (written to ./coverage)
// Without a MongoDB binary (e.g. offline CI sandbox), skip the database-backed
// suites:  $env:SKIP_DB_TESTS = "1"; npm test     (PowerShell)
// Use an already running MongoDB instead of downloading one:
//          $env:TEST_MONGODB_URI = "mongodb://127.0.0.1:27017"; npm test
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  // Third-party services are always replaced in tests, so no test can reach
  // Cloudinary or Mapbox by accident. Control them via tests/helpers/mocks.js.
  moduleNameMapper: {
    "^cloudinary$": "<rootDir>/tests/mocks/cloudinary.js",
    "^@mapbox/mapbox-sdk/services/geocoding$":
      "<rootDir>/tests/mocks/mapboxGeocoding.js",
  },
  clearMocks: true,
  testTimeout: 15000,
  collectCoverageFrom: ["src/**/*.js", "server.js"],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "lcov"],
};
