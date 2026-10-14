// A valid, frozen app config for tests (same shape as loadEnv()).
function testConfig(overrides = {}) {
  return Object.freeze({
    env: "test",
    isProduction: false,
    isTest: true,
    port: 0,
    mongodbUri: "mongodb://127.0.0.1:1/never-connected",
    sessionSecret: "test-session-secret-not-for-production",
    cloudinary: { cloudName: "test", apiKey: "key", apiSecret: "secret" },
    mapbox: { serverToken: "pk.test-server", publicToken: "pk.test-public" },
    appBaseUrl: "http://localhost:0",
    dnsServers: [],
    warnings: [],
    ...overrides,
  });
}

module.exports = { testConfig };
