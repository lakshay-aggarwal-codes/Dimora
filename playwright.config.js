// Playwright configuration (P17-T03): browser tests of the critical journeys.
//   npm run test:e2e            headless, starts e2e/server.js by itself
//   npx playwright test --headed --project=chromium     watch it work
//   npx playwright show-report  open the last HTML report
// First time on a machine:  npx playwright install chromium
// The server (e2e/server.js) uses an in-memory MongoDB and local stand-ins for
// Cloudinary and Mapbox; it never touches your real database or accounts.
const { defineConfig, devices } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 3100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT || 3101);

module.exports = defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  // One shared database and one booking ledger: run the journeys one after the other.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.js",
    url: `http://127.0.0.1:${PORT}/login`,
    // The first start may download a MongoDB binary.
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT), E2E_CONTROL_PORT: String(CONTROL_PORT) },
    stdout: "pipe",
    stderr: "pipe",
  },
});
