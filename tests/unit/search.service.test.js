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

describe("sortSpec (P05-T03)", () => {
  const { sortSpec, searchPage, PAGE_SIZE } = require("../../src/services/search");

  test("every order ends with _id in the same direction, so it is stable", () => {
    for (const name of ["relevance", "price_asc", "price_desc", "rating", "newest"]) {
      for (const hasText of [false, true]) {
        const keys = Object.keys(sortSpec(name, { hasText }).sort);
        expect(keys[keys.length - 1]).toBe("_id");
      }
    }
    expect(sortSpec("price_asc").sort).toEqual({ "pricing.nightlyMinor": 1, _id: 1 });
    expect(sortSpec("price_desc").sort).toEqual({ "pricing.nightlyMinor": -1, _id: -1 });
    expect(sortSpec("newest").sort).toEqual({ createdAt: -1, _id: -1 });
    expect(sortSpec("rating").sort).toEqual({ ratingAvg: -1, ratingCount: -1, _id: -1 });
  });

  test("relevance: text score first when searching by keywords, rating otherwise", () => {
    expect(sortSpec("relevance", { hasText: true })).toEqual({
      projection: { score: { $meta: "textScore" } },
      sort: { score: { $meta: "textScore" }, ratingAvg: -1, ratingCount: -1, _id: -1 },
    });
    expect(sortSpec("relevance")).toEqual({ sort: { ratingAvg: -1, ratingCount: -1, _id: -1 } });
    expect(sortSpec(undefined)).toEqual(sortSpec("relevance"));
  });

  test("an unknown name falls back to relevance, never to a user-chosen sort", () => {
    expect(sortSpec("$natural")).toEqual(sortSpec("relevance"));
    expect(sortSpec("__proto__")).toEqual(sortSpec("relevance"));
  });

  function fakeModel({ total = 0, listings = [] } = {}) {
    const calls = { finds: 0 };
    const chain = {
      sort(a) { calls.sort = a; return chain; },
      skip(a) { calls.skip = a; return chain; },
      limit(a) { calls.limit = a; return chain; },
      then(res, rej) { return Promise.resolve(listings).then(res, rej); },
    };
    return {
      calls,
      async countDocuments(filter) { calls.countFilter = filter; return total; },
      find(filter, projection) { calls.finds += 1; calls.filter = filter; calls.projection = projection; return chain; },
    };
  }

  test("page size is 12", () => {
    expect(PAGE_SIZE).toBe(12);
  });

  test("page 1 of a search: skip 0, limit 12, total and page count", async () => {
    const model = fakeModel({ total: 30, listings: [{ _id: 1 }] });
    const out = await searchPage(model, {});
    expect(model.calls).toMatchObject({ skip: 0, limit: 12 });
    expect(out).toMatchObject({ total: 30, page: 1, totalPages: 3, pageSize: 12, sort: "relevance", outOfRange: false });
    expect(out.listings).toEqual([{ _id: 1 }]);
    expect(model.calls.countFilter).toEqual(model.calls.filter); // the count and the list use the same filter
  });

  test("page 3 skips 24; the last page can be short", async () => {
    const model = fakeModel({ total: 30, listings: [] });
    const out = await searchPage(model, { page: "3" });
    expect(model.calls.skip).toBe(24);
    expect(out.page).toBe(3);
    expect(out.outOfRange).toBe(false);
  });

  test("exactly a full page: one page, and page 2 is out of range", async () => {
    const model = fakeModel({ total: 12 });
    expect((await searchPage(model, {})).totalPages).toBe(1);
    const beyond = await searchPage(model, { page: "2" });
    expect(beyond.outOfRange).toBe(true);
  });

  test("a page past the last returns no listings, says so, and does not query for them", async () => {
    const model = fakeModel({ total: 30, listings: [{ _id: 1 }] });
    const out = await searchPage(model, { page: "9" });
    expect(out).toMatchObject({ listings: [], outOfRange: true, totalPages: 3, page: 9 });
    expect(model.calls.finds).toBe(0);
  });

  test("no results at all is page 1 of 1, not out of range", async () => {
    const out = await searchPage(fakeModel({ total: 0 }), {});
    expect(out).toMatchObject({ total: 0, totalPages: 1, page: 1, outOfRange: false, listings: [] });
  });

  test("sort name picks the order; keywords add the text score projection", async () => {
    const model = fakeModel({ total: 5 });
    await searchPage(model, { sort: "price_asc" });
    expect(model.calls.sort).toEqual({ "pricing.nightlyMinor": 1, _id: 1 });
    expect(model.calls.projection).toBeUndefined();
    await searchPage(model, { keywords: "villa" });
    expect(model.calls.projection).toEqual({ score: { $meta: "textScore" } });
    expect(model.calls.sort.score).toEqual({ $meta: "textScore" });
  });

  test("an invalid sort or page is reported and replaced by the default", async () => {
    const out = await searchPage(fakeModel({ total: 5 }), { sort: "cheapest", page: "abc" });
    expect(Object.keys(out.errors).sort()).toEqual(["page", "sort"]);
    expect(out.sort).toBe("relevance");
    expect(out.page).toBe(1);
  });
});
