// P05-T04 against a real MongoDB: every category returns only the listings that
// match it, and all of them. Needs a MongoDB (see tests/helpers/db.js); skipped
// with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { searchListings } = require("../../src/services/search");
const { CATEGORIES } = require("../../src/config/categories");

const titles = async (query) =>
  (await searchListings(Listing, query)).listings.map((listing) => listing.title).sort();

async function fixtures() {
  const make = (title, extra) => createListing({ title, ...extra });
  await make("Beach villa with pool", { vibe: "beach", propertyType: "villa", roomType: "entire_place", amenities: ["wifi", "pool"] });
  await make("Beach cabin", { vibe: "beach", propertyType: "cabin", roomType: "entire_place", amenities: ["wifi"] });
  await make("Mountain cabin", { vibe: "mountain", propertyType: "cabin", roomType: "entire_place", amenities: ["heating"] });
  await make("Lake house", { vibe: "lake", propertyType: "house", roomType: "entire_place" });
  await make("Desert villa with pool", { vibe: "desert", propertyType: "villa", roomType: "entire_place", amenities: ["pool"] });
  await make("Countryside farm", { vibe: "countryside", propertyType: "farm_stay", roomType: "entire_place" });
  await make("City flat", { vibe: "city", propertyType: "apartment", roomType: "entire_place" });
  await make("City room", { vibe: "city", propertyType: "apartment", roomType: "private_room" });
  await make("Shared room", { propertyType: "apartment", roomType: "shared_room" });
  await make("Old listing without a setting", {});
  // Never public, whatever they are:
  await make("Draft beach villa", { vibe: "beach", propertyType: "villa", status: "draft", amenities: ["pool"] });
  await make("Deleted beach villa", { vibe: "beach", propertyType: "villa", deletedAt: new Date(), amenities: ["pool"] });
  await make("Unpublished mountain cabin", { vibe: "mountain", propertyType: "cabin", status: "unpublished" });
}

const EXPECTED = {
  beach: ["Beach cabin", "Beach villa with pool"],
  mountains: ["Mountain cabin"],
  lakefront: ["Lake house"],
  desert: ["Desert villa with pool"],
  countryside: ["Countryside farm"],
  city: ["City flat", "City room"],
  "farm-stays": ["Countryside farm"],
  cabins: ["Beach cabin", "Mountain cabin"],
  villas: ["Beach villa with pool", "Desert villa with pool"],
  apartments: ["City flat", "City room", "Shared room"],
  "amazing-pools": ["Beach villa with pool", "Desert villa with pool"],
  rooms: ["City room", "Shared room"],
};

describeDb("category filter", () => {
  useTestDb();

  test("every category is covered by this test", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(CATEGORIES.map((category) => category.slug).sort());
  });

  test.each(Object.entries(EXPECTED))("%s returns exactly the matching published listings", async (slug, expected) => {
    await fixtures();
    expect(await titles({ category: slug })).toEqual([...expected].sort());
  });

  test("a category narrows the other filters", async () => {
    await fixtures();
    expect(await titles({ category: "beach", propertyType: "villa" })).toEqual(["Beach villa with pool"]);
    expect(await titles({ category: "beach", amenities: "pool" })).toEqual(["Beach villa with pool"]);
    expect(await titles({ category: "cabins", destination: "new delhi" })).toEqual(["Beach cabin", "Mountain cabin"]);
  });

  test("a category and a property type that cannot both be true match nothing", async () => {
    await fixtures();
    expect(await titles({ category: "farm-stays", propertyType: "villa" })).toEqual([]);
  });

  test("a listing with no setting appears under no setting category", async () => {
    await fixtures();
    for (const slug of ["beach", "mountains", "lakefront", "desert", "countryside", "city"]) {
      expect(await titles({ category: slug })).not.toContain("Old listing without a setting");
    }
  });

  test("an unknown category is ignored by the service (the page shows a message)", async () => {
    await fixtures();
    const all = await titles({});
    expect(await titles({ category: "trending" })).toEqual(all);
  });
});
