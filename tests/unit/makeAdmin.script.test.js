// P14-T01: argument and environment handling of scripts/make-admin.js.
const { parseArgs, resolveMongoUri } = require("../../scripts/make-admin");
const { BootstrapError } = require("../../src/services/adminBootstrap");

describe("parseArgs", () => {
  test("exactly one email", () => {
    expect(parseArgs(["me@example.com"])).toEqual({ email: "me@example.com" });
  });

  test.each([[[]], [["a@b.co", "c@d.co"]], [["--help"]], [["-x"]]])("%j is a usage error", (argv) => {
    expect(() => parseArgs(argv)).toThrow(BootstrapError);
  });
});

describe("resolveMongoUri", () => {
  test("uses MONGODB_URI, then the old ATLASDB_URL", () => {
    expect(resolveMongoUri({ MONGODB_URI: " mongodb://a " })).toBe("mongodb://a");
    expect(resolveMongoUri({ ATLASDB_URL: "mongodb://b" })).toBe("mongodb://b");
  });

  test("a missing URI is a clear error that does not print anything secret", () => {
    expect(() => resolveMongoUri({})).toThrow(/MONGODB_URI is not set/);
  });
});
