// P05-T01: the filter built from validated parameters (no database).
const {
  buildFilter,
  searchFilterFor,
  searchListings,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require("../../src/services/search");

const BASE = { status: "published", deletedAt: null };

describe("buildFilter", () => {
  test("no parameters: only published, not deleted listings", () => {
    expect(buildFilter({})).toEqual(BASE);
    expect(buildFilter()).toEqual(BASE);
  });

  test("destination: each comma part must start the city, state or country key", () => {
    const filter = buildFilter({ destination: "Panaji, Goa" });
    expect(filter.$and).toHaveLength(2);
    const [first, second] = filter.$and;
    expect(first.$or.map((c) => Object.keys(c)[0])).toEqual(["cityKey", "stateKey", "countryKey"]);
    expect(first.$or[0].cityKey).toBeInstanceOf(RegExp);
    expect(first.$or[0].cityKey.test("panaji")).toBe(true);
    expect(first.$or[0].cityKey.test("new panaji")).toBe(false); // starts-with, not contains
    expect(second.$or[1].stateKey.test("goa")).toBe(true);
  });

  test("a destination made of regex characters matches them literally and nothing else", () => {
    const [{ $or }] = buildFilter({ destination: "go.a" }).$and; // "." becomes a space
    expect($or[0].cityKey.test("go a")).toBe(true);
    expect($or[0].cityKey.test("goxa")).toBe(false);
    expect(buildFilter({ destination: ".*" }).$and).toBeUndefined(); // nothing left to search for
  });

  test("keywords use the text index", () => {
    expect(buildFilter({ keywords: " sea view " }).$text).toEqual({ $search: "sea view" });
    expect(buildFilter({ keywords: "  " }).$text).toBeUndefined();
  });

  test("prices are rupees in the form and paise in the filter", () => {
    expect(buildFilter({ minPrice: 1000 })["pricing.nightlyMinor"]).toEqual({ $gte: 100000 });
    expect(buildFilter({ maxPrice: 5000.5 })["pricing.nightlyMinor"]).toEqual({ $lte: 500050 });
    expect(buildFilter({ minPrice: 0, maxPrice: 10 })["pricing.nightlyMinor"]).toEqual({
      $gte: 0,
      $lte: 1000,
    });
  });

  test("guests and bedrooms are minimums", () => {
    const filter = buildFilter({ guests: 4, bedrooms: 0 });
    expect(filter["capacity.guests"]).toEqual({ $gte: 4 });
    expect(filter["capacity.bedrooms"]).toEqual({ $gte: 0 });
  });

  test("types match any of the choices, amenities need all of them, instant book only when asked", () => {
    const filter = buildFilter({
      propertyType: ["villa", "cabin"],
      roomType: ["entire_place"],
      amenities: ["wifi", "pool"],
      instantBook: true,
    });
    expect(filter.propertyType).toEqual({ $in: ["villa", "cabin"] });
    expect(filter.roomType).toEqual({ $in: ["entire_place"] });
    expect(filter.amenities).toEqual({ $all: ["wifi", "pool"] });
    expect(filter.instantBook).toBe(true);
    expect(buildFilter({ instantBook: false }).instantBook).toBeUndefined();
  });

  test("everything together", () => {
    const filter = buildFilter({
      destination: "Goa",
      keywords: "beach",
      minPrice: 1000,
      maxPrice: 4000,
      guests: 2,
      propertyType: ["villa"],
      amenities: ["wifi"],
      instantBook: true,
    });
    expect(Object.keys(filter).sort()).toEqual(
      [
        "$and",
        "$text",
        "amenities",
        "capacity.guests",
        "deletedAt",
        "instantBook",
        "pricing.nightlyMinor",
        "propertyType",
        "status",
      ].sort(),
    );
  });

  test("values that are not the expected type are ignored, never put in the filter", () => {
    const filter = buildFilter({
      destination: { $ne: "x" },
      keywords: { $where: "1" },
      minPrice: "1000",
      guests: "4",
      propertyType: "villa",
      amenities: { $in: ["a"] },
      instantBook: "true",
    });
    expect(filter).toEqual(BASE);
  });
});

describe("searchFilterFor", () => {
  test("validates a raw query, then builds the filter from the valid part", () => {
    const { params, errors, filter } = searchFilterFor({
      destination: "Goa",
      guests: "abc",
      "price[$gt]": "5",
    });
    expect(params).toEqual({ destination: "Goa" });
    expect(Object.keys(errors)).toEqual(["guests"]);
    expect(filter["capacity.guests"]).toBeUndefined();
    expect(filter.$and).toHaveLength(1);
  });

  test("operator payloads never reach the filter", () => {
    const { filter, errors } = searchFilterFor({
      guests: { $gt: "0" },
      destination: { $regex: ".*" },
      minPrice: { $gt: 0 },
    });
    expect(filter).toEqual(BASE);
    expect(Object.keys(errors).sort()).toEqual(["destination", "guests", "minPrice"]);
  });
});

describe("searchListings", () => {
  function fakeModel(result = []) {
    const calls = {};
    const chain = {
      sort(arg) {
        calls.sort = arg;
        return chain;
      },
      skip(arg) {
        calls.skip = arg;
        return chain;
      },
      limit(arg) {
        calls.limit = arg;
        return chain;
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return {
      calls,
      find(filter) {
        calls.filter = filter;
        return chain;
      },
    };
  }

  test("searches with the built filter, newest first, with the default page size", async () => {
    const model = fakeModel([{ _id: 1 }]);
    const out = await searchListings(model, { guests: "2" });
    expect(model.calls.filter["capacity.guests"]).toEqual({ $gte: 2 });
    expect(model.calls.sort).toEqual({ _id: -1 });
    expect(model.calls.limit).toBe(DEFAULT_LIMIT);
    expect(model.calls.skip).toBe(0);
    expect(out.listings).toEqual([{ _id: 1 }]);
  });

  test("the page size is kept between 1 and the maximum; junk falls back to the defaults", async () => {
    const model = fakeModel();
    await searchListings(model, {}, { limit: 100000, skip: -5 });
    expect(model.calls.limit).toBe(MAX_LIMIT);
    expect(model.calls.skip).toBe(0);
    await searchListings(model, {}, { limit: 0 });
    expect(model.calls.limit).toBe(1);
    await searchListings(model, {}, { limit: "9", skip: "9" });
    expect(model.calls.limit).toBe(DEFAULT_LIMIT);
    expect(model.calls.skip).toBe(0);
  });
});
