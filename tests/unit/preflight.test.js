// P17-T04: the production readiness rules (src/config/preflight.js), with the
// app's own environment check replaced by a fake. One test uses the real one.
const { checkProduction } = require("../../src/config/preflight");

const GOOD = {
  MONGODB_URI: "mongodb+srv://cluster0.example.mongodb.net/dimora",
  SESSION_SECRET: "k9Xr2Lq7VbT4mZ8cWd1NfH6yJ3sPa0Ge5UoRiCxQ",
  APP_BASE_URL: "https://dimora.example.com",
  NEARBY_CONTACT: "ops@dimora.example.com",
};
const context = {
  validate: () => ({}),
  gitignoreText: "node_modules/\n.env\n",
  hasLockfile: true,
  nodeVersion: "v22.1.0",
};
const levels = (result, level) => result.results.filter((r) => r.level === level).map((r) => r.id);

describe("checkProduction", () => {
  test("a good setup passes with no warnings", () => {
    const result = checkProduction(GOOD, context);
    expect(result.ok).toBe(true);
    expect(levels(result, "warn")).toEqual([]);
    expect(levels(result, "fail")).toEqual([]);
  });

  test("http, local addresses, a weak secret, and a missing .gitignore entry fail", () => {
    const result = checkProduction(
      {
        ...GOOD,
        APP_BASE_URL: "http://localhost:8080",
        MONGODB_URI: "mongodb://127.0.0.1:27017/dimora",
        SESSION_SECRET: "a".repeat(40),
      },
      { ...context, gitignoreText: "node_modules/\n" },
    );
    expect(result.ok).toBe(false);
    expect(levels(result, "fail").sort()).toEqual(["database", "gitignore", "https", "secret"]);
  });

  test("warnings do not fail: no contact for Overpass, sweeper off, unencrypted URI", () => {
    const result = checkProduction(
      { ...GOOD, NEARBY_CONTACT: "", SWEEPER_ENABLED: "false", MONGODB_URI: "mongodb://db.example.com:27017/dimora" },
      context,
    );
    expect(result.ok).toBe(true);
    expect(levels(result, "warn").sort()).toEqual(["database", "nearby", "sweeper"]);
  });

  test("nearby switched off needs no contact", () => {
    const result = checkProduction({ ...GOOD, NEARBY_CONTACT: "", NEARBY_ENABLED: "false" }, context);
    expect(levels(result, "warn")).toEqual([]);
  });

  test("an old Node or a missing lockfile fail", () => {
    const result = checkProduction(GOOD, { ...context, nodeVersion: "v18.19.0", hasLockfile: false });
    expect(levels(result, "fail").sort()).toEqual(["lockfile", "node"]);
  });

  test("problems the app's own check reports are failures, and values are not repeated", () => {
    const { EnvValidationError } = require("../../src/config/env");
    const validate = () => {
      throw new EnvValidationError(["SESSION_SECRET must be at least 32 characters in production"]);
    };
    const result = checkProduction(GOOD, { ...context, validate });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result).includes(GOOD.SESSION_SECRET)).toBe(false);
  });

  test("the real environment check is used by default, with NODE_ENV forced to production", () => {
    const result = checkProduction({ NODE_ENV: "development", ...GOOD });
    // Cloudinary and Mapbox keys are missing: the real check says so.
    expect(result.ok).toBe(false);
    expect(result.results.some((r) => r.id === "env" && /CLOUDINARY_CLOUD_NAME is missing/.test(r.message))).toBe(true);
  });
});
