// P05-T01 against a real MongoDB: each filter alone and combined on fixture
// data, the stored search keys, operator-injection payloads, and an explain()
// check that the destination and price filters use an index. Needs a MongoDB
// (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { searchListings, explainSearch } = require("../../src/services/search");

const place = (city, state, country) => ({ address: { city, state, country }, location: `${city}, ${state}`, country });

async function fixtures() {
  const make = (title, extra) => createListing({ title, ...extra });
  return {
    goaVilla: await make("Goa beach villa", {
      ...place("Panaji", "Goa", "India"),
      description: "A quiet villa near the sea with a pool.",
      price: 6000,
      propertyType: "villa",
      roomType: "entire_place",
      amenities: ["wifi", "pool", "kitchen"],
      capacity: { guests: 8, bedrooms: 4, beds: 5, bathrooms: 3 },
      instantBook: true,
    }),
    goaRoom: await make("Cheap room in Goa", {
      ...place("Margao", "Goa", "India"),
      description: "A simple private room, walk to the market.",
      price: 900,
      propertyType: "apartment",
      roomType: "private_room",
      amenities: ["wifi"],
      capacity: { guests: 2, bedrooms: 1, beds: 1, bathrooms: 1 },
    }),
    manaliCabin: await make("Manali mountain cabin", {
      ...place("Manali", "Himachal Pradesh", "India"),
      description: "Wood cabin with a fireplace and mountain views.",
      price: 3500,
      propertyType: "cabin",
      roomType: "entire_place",
      amenities: ["heating", "wifi"],
      capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
    }),
    paris: await make("Paris flat", {
      ...place("Paris", "Île-de-France", "France"),
      description: "Bright flat near the river.",
      price: 12000,
      propertyType: "apartment",
      roomType: "entire_place",
      amenities: ["wifi", "workspace"],
      capacity: { guests: 3, bedrooms: 1, beds: 2, bathrooms: 1 },
    }),
    draft: await make("Draft in Goa", { ...place("Panaji", "Goa", "India"), status: "draft" }),
    deleted: await make("Deleted in Goa", { ...place("Panaji", "Goa", "India"), deletedAt: new Date() }),
    unpublished: await make("Unpublished in Goa", { ...place("Panaji", "Goa", "India"), status: "unpublished" }),
  };
}

const titles = async (query, options) =>
  (await searchListings(Listing, query, options)).listings.map((l) => l.title).sort();

describeDb("search", () => {
  useTestDb();

  test("no filters: every published, not deleted listing and nothing else", async () => {
    await fixtures();
    expect(await titles({})).toEqual([
      "Cheap room in Goa",
      "Goa beach villa",
      "Manali mountain cabin",
      "Paris flat",
    ]);
  });

  describe("stored search keys", () => {
    test("a new listing gets lower-case, accent-free keys from its address", async () => {
      const f = await fixtures();
      const paris = await Listing.findById(f.paris._id);
      expect(paris.cityKey).toBe("paris");
      expect(paris.stateKey).toBe("ile de france");
      expect(paris.countryKey).toBe("france");
      expect(paris.locationKey).toBe("paris|ile de france|france");
    });

    test("changing the address on save changes the keys", async () => {
      const f = await fixtures();
      const listing = await Listing.findById(f.goaRoom._id);
      listing.set("address.city", "Calangute");
      await listing.save();
      expect((await Listing.findById(f.goaRoom._id)).cityKey).toBe("calangute");
      expect(await titles({ destination: "Calangute" })).toEqual(["Cheap room in Goa"]);
      expect(await titles({ destination: "Margao" })).toEqual([]);
    });

    test("a listing written before the wizard (free-text location only) is found by it", async () => {
      await fixtures();
      await createListing({ title: "Old style", address: undefined, location: "Jaipur", country: "India" });
      expect(await titles({ destination: "Jaipur" })).toEqual(["Old style"]);
    });
  });

  describe("each filter alone", () => {
    beforeEach(fixtures);

    test("destination: a city, a state or a country, from its first letters, any case or accent", async () => {
      expect(await titles({ destination: "panaji" })).toEqual(["Goa beach villa"]);
      expect(await titles({ destination: "PAN" })).toEqual(["Goa beach villa"]);
      expect(await titles({ destination: "goa" })).toEqual(["Cheap room in Goa", "Goa beach villa"]);
      expect(await titles({ destination: "france" })).toEqual(["Paris flat"]);
      expect(await titles({ destination: "ile de" })).toEqual(["Paris flat"]);
      expect(await titles({ destination: "Île-de-France" })).toEqual(["Paris flat"]);
      expect(await titles({ destination: "india" })).toHaveLength(3);
    });

    test("destination is 'starts with', not 'contains'", async () => {
      expect(await titles({ destination: "anaji" })).toEqual([]);
    });

    test("destination with several parts needs all of them", async () => {
      expect(await titles({ destination: "Panaji, Goa" })).toEqual(["Goa beach villa"]);
      expect(await titles({ destination: "Panaji, France" })).toEqual([]);
      expect(await titles({ destination: "Goa, India" })).toEqual(["Cheap room in Goa", "Goa beach villa"]);
    });

    test("keywords use the text index on title and description", async () => {
      expect(await titles({ keywords: "cabin" })).toEqual(["Manali mountain cabin"]);
      expect(await titles({ keywords: "fireplace" })).toEqual(["Manali mountain cabin"]);
      expect(await titles({ keywords: "nonexistentword" })).toEqual([]);
    });

    test("price: minimum, maximum and a range, in rupees", async () => {
      expect(await titles({ minPrice: "5000" })).toEqual(["Goa beach villa", "Paris flat"]);
      expect(await titles({ maxPrice: "1000" })).toEqual(["Cheap room in Goa"]);
      expect(await titles({ minPrice: "900", maxPrice: "3500" })).toEqual([
        "Cheap room in Goa",
        "Manali mountain cabin",
      ]);
    });

    test("guests and bedrooms are minimums", async () => {
      expect(await titles({ guests: "4" })).toEqual(["Goa beach villa", "Manali mountain cabin"]);
      expect(await titles({ guests: "9" })).toEqual([]);
      expect(await titles({ bedrooms: "2" })).toEqual(["Goa beach villa", "Manali mountain cabin"]);
    });

    test("property type and room type match any of the choices", async () => {
      expect(await titles({ propertyType: "cabin" })).toEqual(["Manali mountain cabin"]);
      expect(await titles({ propertyType: ["cabin", "villa"] })).toEqual([
        "Goa beach villa",
        "Manali mountain cabin",
      ]);
      expect(await titles({ roomType: "private_room" })).toEqual(["Cheap room in Goa"]);
    });

    test("amenities must all be present", async () => {
      expect(await titles({ amenities: "pool" })).toEqual(["Goa beach villa"]);
      expect(await titles({ amenities: ["wifi", "pool"] })).toEqual(["Goa beach villa"]);
      expect(await titles({ amenities: ["wifi", "heating"] })).toEqual(["Manali mountain cabin"]);
      expect(await titles({ amenities: ["pool", "heating"] })).toEqual([]);
    });

    test("instant book only when asked", async () => {
      expect(await titles({ instantBook: "1" })).toEqual(["Goa beach villa"]);
      expect(await titles({ instantBook: "0" })).toHaveLength(4);
    });
  });

  describe("combined", () => {
    beforeEach(fixtures);

    test("filters narrow each other down", async () => {
      expect(await titles({ destination: "Goa", guests: "4", maxPrice: "7000" })).toEqual(["Goa beach villa"]);
      expect(await titles({ destination: "Goa", maxPrice: "1000", amenities: "wifi" })).toEqual(["Cheap room in Goa"]);
      expect(await titles({ destination: "India", propertyType: "apartment" })).toEqual(["Cheap room in Goa"]);
      expect(await titles({ keywords: "villa", destination: "Goa", amenities: "pool", instantBook: "on" })).toEqual([
        "Goa beach villa",
      ]);
      expect(await titles({ destination: "France", guests: "10" })).toEqual([]);
    });

    test("drafts, unpublished and deleted listings never appear, whatever the filters", async () => {
      expect(await titles({ destination: "Panaji" })).toEqual(["Goa beach villa"]);
      expect(await titles({ keywords: "Draft Deleted Unpublished" })).toEqual([]);
    });
  });

  describe("operator injection", () => {
    beforeEach(fixtures);

    test("objects where a value belongs are refused and the search runs without them", async () => {
      const result = await searchListings(Listing, { guests: { $gt: "0" }, destination: { $regex: ".*" } });
      expect(Object.keys(result.errors).sort()).toEqual(["destination", "guests"]);
      expect(result.listings).toHaveLength(4); // the same as no filters, not "everything matching an operator"
      expect(JSON.stringify(result.filter)).not.toContain("$gt");
      expect(JSON.stringify(result.filter)).not.toContain("$regex");
    });

    test("a destination full of regular-expression characters matches nothing, and does not hang or throw", async () => {
      for (const destination of [".*", "(a+)+$", "[a-", "\\", "^", "$where", "a{1,}"]) {
        const result = await searchListings(Listing, { destination });
        expect(result.listings.length).toBeLessThanOrEqual(4);
      }
      expect(await titles({ destination: ".*" })).toHaveLength(4); // nothing searchable left: no destination filter
      // punctuation is not interpreted: "go.*" is just "go"
      expect(await titles({ destination: "go.*" })).toEqual(["Cheap room in Goa", "Goa beach villa"]);
    });

    test("duplicate parameters (?guests=1&guests=9) are refused", async () => {
      const result = await searchListings(Listing, { guests: ["1", "9"] });
      expect(Object.keys(result.errors)).toEqual(["guests"]);
    });

    test("$where and other operator names in the query are dropped", async () => {
      const result = await searchListings(Listing, { $where: "sleep(5000)", "guests[$gt]": "1" });
      expect(result.errors).toEqual({});
      expect(result.listings).toHaveLength(4);
    });
  });

  describe("indexes (explain)", () => {
    const stagesOf = (plan, out = []) => {
      if (!plan || typeof plan !== "object") return out;
      if (plan.stage) out.push({ stage: plan.stage, indexName: plan.indexName });
      for (const key of ["inputStage", "queryPlan", "winningPlan"]) stagesOf(plan[key], out);
      for (const child of plan.inputStages || []) stagesOf(child, out);
      return out;
    };

    test("a destination search is served by an index, not a scan of every listing", async () => {
      await fixtures();
      await Listing.init(); // make sure the indexes exist
      const explain = await explainSearch(Listing, { destination: "panaji" });
      const stages = stagesOf(explain.queryPlanner.winningPlan);
      expect(stages.some((s) => s.stage === "IXSCAN")).toBe(true);
      expect(stages.some((s) => s.stage === "COLLSCAN")).toBe(false);
    });

    test("a price filter is served by an index too", async () => {
      await fixtures();
      await Listing.init();
      const explain = await explainSearch(Listing, { destination: "goa", minPrice: "1000", maxPrice: "7000" });
      const stages = stagesOf(explain.queryPlanner.winningPlan);
      expect(stages.some((s) => s.stage === "IXSCAN")).toBe(true);
    });

    test("the search indexes are declared in the database", async () => {
      await Listing.init();
      const names = (await Listing.collection.indexes()).map((i) => i.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "status_1_cityKey_1_pricing.nightlyMinor_1",
          "status_1_countryKey_1_pricing.nightlyMinor_1",
          "title_text_description_text",
        ]),
      );
    });
  });
});
