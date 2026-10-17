// P01-T06: the seed data and the pure helpers of scripts/seed.js. No database:
// every sample listing is validated against the real Listing model in memory.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mongoose = require("mongoose");
const Listing = require("../../src/models/listing");
const {
  buildSeedListings,
  assertSeedAllowed,
  resolveMongoUri,
  parseArgs,
  SeedError,
} = require("../../scripts/seed");
const { data } = require("../../scripts/seed-data");

describe("seed data", () => {
  const owner = new mongoose.Types.ObjectId();

  test("has the 29 sample listings with unique titles", () => {
    expect(data).toHaveLength(29);
    expect(new Set(data.map((item) => item.title)).size).toBe(29);
  });

  test("every listing passes model validation (D-05: geometry was missing)", () => {
    for (const doc of buildSeedListings(owner)) {
      const error = new Listing(doc).validateSync();
      expect(error ? `${doc.title}: ${error.message}` : undefined).toBeUndefined();
    }
  });

  test("every listing has a GeoJSON Point inside the valid range", () => {
    for (const item of data) {
      expect(item.geometry.type).toBe("Point");
      const [lng, lat] = item.geometry.coordinates;
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
  });

  test("every listing has a price, an image url and a location", () => {
    for (const item of data) {
      expect(typeof item.price).toBe("number");
      expect(item.image.url).toMatch(/^https:\/\//);
      expect(item.location).toBeTruthy();
      expect(item.country).toBeTruthy();
    }
  });

  test("every built seed listing carries search keys that match what the model computes from its address", () => {
    const { keysForListing } = require("../../src/utils/searchKeys");
    for (const doc of buildSeedListings(owner)) {
      const expected = keysForListing(new Listing(doc));
      expect({ title: doc.title, cityKey: doc.cityKey, locationKey: doc.locationKey }).toEqual({
        title: doc.title,
        cityKey: expected.cityKey,
        locationKey: expected.locationKey,
      });
      expect(doc.cityKey).toBeTruthy();
      expect(doc.countryKey).toBeTruthy();
    }
  });

  test("buildSeedListings sets the owner and does not modify the seed data", () => {
    const built = buildSeedListings(owner);
    expect(built).toHaveLength(29);
    expect(built.every((doc) => String(doc.owner) === String(owner))).toBe(true);
    expect(data.some((item) => "owner" in item)).toBe(false);
  });
});

describe("seed script guards", () => {
  test("refuses to run in production", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(SeedError);
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(/production/);
  });

  test("allows development, test and an unset NODE_ENV", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: "test" })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });

  test("needs MONGODB_URI (the old ATLASDB_URL still works)", () => {
    expect(() => resolveMongoUri({})).toThrow(/MONGODB_URI/);
    expect(resolveMongoUri({ MONGODB_URI: " mongodb://h/db " })).toBe("mongodb://h/db");
    expect(resolveMongoUri({ ATLASDB_URL: "mongodb://old/db" })).toBe("mongodb://old/db");
  });

  test("--reset is the only accepted option", () => {
    expect(parseArgs([])).toEqual({ reset: false });
    expect(parseArgs(["--reset"])).toEqual({ reset: true });
    expect(() => parseArgs(["--drop"])).toThrow(/Unknown argument/);
  });

  test("running the script with NODE_ENV=production exits non-zero before connecting", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "..", "..", "scripts", "seed.js")],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/production/);
    expect(result.stdout).not.toMatch(/Connected to DB/);
  });
});
