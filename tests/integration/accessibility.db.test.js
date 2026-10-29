// P15-T05 against a real MongoDB: the accessibility filter needs ALL the asked
// features, never matches a listing that declared nothing, and only returns
// public listings. Needs a MongoDB (see tests/helpers/db.js); skipped with
// SKIP_DB_TESTS=1. Written but not run where there was no mongod.
const { describeDb, useTestDb } = require("../helpers/db");
const { createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { searchListings } = require("../../src/services/search");

const titles = async (query) =>
  (await searchListings(Listing, query)).listings.map((l) => l.title).sort();

describeDb("accessibility filter with a real database", () => {
  useTestDb();

  beforeEach(async () => {
    await createListing({
      title: "Ramp and lift",
      accessibility: ["step_free_entrance", "elevator"],
    });
    await createListing({
      title: "Everything",
      accessibility: [
        "step_free_entrance",
        "step_free_bathroom",
        "elevator",
        "wide_doorway",
        "grab_rails",
        "accessible_parking",
      ],
    });
    await createListing({
      title: "Parking only",
      accessibility: ["accessible_parking"],
    });
    await createListing({ title: "Declared nothing", accessibility: [] });
    await createListing({ title: "Old listing" });
    await createListing({
      title: "Draft with lift",
      status: "draft",
      accessibility: ["elevator"],
    });
    await createListing({
      title: "Deleted with lift",
      deletedAt: new Date(),
      accessibility: ["elevator"],
    });
  });

  test("one feature returns every public listing that declared it", async () => {
    expect(await titles({ access: "elevator" })).toEqual([
      "Everything",
      "Ramp and lift",
    ]);
  });

  test("two features need both", async () => {
    expect(await titles({ access: ["elevator", "grab_rails"] })).toEqual([
      "Everything",
    ]);
    expect(
      await titles({ access: ["elevator", "accessible_parking"] }),
    ).toEqual(["Everything"]);
  });

  test("a listing that declared nothing, or never had the field, is not returned", async () => {
    const found = await titles({ access: "step_free_entrance" });
    expect(found).not.toContain("Declared nothing");
    expect(found).not.toContain("Old listing");
  });

  test("drafts and deleted listings never show up", async () => {
    const found = await titles({ access: "elevator" });
    expect(found).not.toContain("Draft with lift");
    expect(found).not.toContain("Deleted with lift");
  });

  test("with no accessibility filter nothing is left out because of it", async () => {
    expect(await titles({})).toEqual(
      [
        "Declared nothing",
        "Everything",
        "Old listing",
        "Parking only",
        "Ramp and lift",
      ].sort(),
    );
  });

  test("an operator payload is refused, not run", async () => {
    const result = await searchListings(Listing, { access: { $ne: "x" } });
    expect(result.errors.access).toBeTruthy();
    expect(result.listings.length).toBe(5);
  });
});
