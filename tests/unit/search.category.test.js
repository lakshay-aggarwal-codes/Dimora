// P05-T04: `category` through validation, the URL state and the Mongo filter (no database).
const { parseSearchParams } = require("../../src/validation/search");
const { buildFilter } = require("../../src/services/search");
const { parseListingQuery } = require("../../src/validation/searchQuery");
const { listingsUrl, hiddenFields } = require("../../src/utils/searchUrl");
const { CATEGORIES, CATEGORY_SLUGS } = require("../../src/config/categories");

const NOW = new Date("2026-10-17T10:00:00Z");
const parse = (query) => parseListingQuery(query, { now: NOW });

describe("validation", () => {
  test.each(CATEGORY_SLUGS)("%s is accepted", (slug) => {
    const { value, errors } = parseSearchParams({ category: slug });
    expect(errors).toEqual({});
    expect(value).toEqual({ category: slug });
  });

  test("empty means no category", () => {
    expect(parseSearchParams({ category: "" })).toEqual({ value: {}, errors: {} });
  });

  test.each([
    ["an unknown name", "trending"],
    ["a different case", "Beach"],
    ["two categories", ["beach", "cabins"]],
    ["an operator object", { $ne: "x" }],
    ["a number", 5],
  ])("%s is refused with one plain message", (_label, category) => {
    const { value, errors } = parseSearchParams({ category, guests: "2" });
    expect(errors.category).toBe("Category is not one of the choices.");
    expect(value.category).toBeUndefined();
    expect(value.guests).toBe(2); // the rest still searches
  });
});

describe("the filter", () => {
  test("a setting or a type becomes one extra condition", () => {
    expect(buildFilter({ category: "beach" }).$and).toEqual([{ vibe: { $in: ["beach"] } }]);
    expect(buildFilter({ category: "cabins" }).$and).toEqual([{ propertyType: { $in: ["cabin"] } }]);
    expect(buildFilter({ category: "amazing-pools" }).$and).toEqual([{ amenities: { $all: ["pool"] } }]);
    expect(buildFilter({ category: "rooms" }).$and).toEqual([
      { roomType: { $in: ["private_room", "shared_room"] } },
    ]);
  });

  test("every category adds exactly one condition and nothing else", () => {
    for (const { slug } of CATEGORIES) {
      const filter = buildFilter({ category: slug });
      expect(Object.keys(filter).sort()).toEqual(["$and", "deletedAt", "status"]);
      expect(filter.$and).toHaveLength(1);
    }
  });

  test("it narrows the other filters instead of replacing them", () => {
    const filter = buildFilter({ destination: "Goa", category: "villas", propertyType: ["cabin"], amenities: ["wifi"] });
    expect(filter.$and).toHaveLength(2); // the destination and the category
    expect(filter.$and[1]).toEqual({ propertyType: { $in: ["villa"] } });
    expect(filter.propertyType).toEqual({ $in: ["cabin"] }); // both apply: nothing matches both
    expect(filter.amenities).toEqual({ $all: ["wifi"] });
  });

  test("an unknown category adds nothing", () => {
    expect(buildFilter({ category: "trending" })).toEqual({ status: "published", deletedAt: null });
  });

  test("only published, not deleted listings, whatever the category", () => {
    const filter = buildFilter({ category: "beach" });
    expect(filter.status).toBe("published");
    expect(filter.deletedAt).toBeNull();
  });
});

describe("the page's URL state", () => {
  test("a valid category is in the state and the search parameters", () => {
    const { state, searchParams, errors } = parse({ category: "beach", dest: "Goa" });
    expect(errors).toEqual({});
    expect(state).toEqual({ dest: "Goa", category: "beach" });
    expect(searchParams.category).toBe("beach");
  });

  test("a wrong category gets a message and never stops the rest", () => {
    const { state, errors } = parse({ category: "castles", dest: "Goa" });
    expect(errors.category).toBe("Category is not one of the choices.");
    expect(state).toEqual({ dest: "Goa" });
  });

  test("the old links with names that no longer exist show that message", () => {
    expect(parse({ category: "beaches" }).errors.category).toBeTruthy();
    expect(parse({ category: "trending" }).errors.category).toBeTruthy();
  });

  test("operator-looking category values are refused", () => {
    expect(parse({ category: { $ne: "x" } }).errors.category).toBeTruthy();
    expect(parse({ "category[$ne]": "x" }).state).toEqual({});
  });

  test("the panel's number boxes show what was typed, valid or not", () => {
    const { drawer } = parse({ minPrice: "abc", maxPrice: "5000", bedrooms: "2" });
    expect(drawer).toEqual({ minPrice: "abc", maxPrice: "5000", bedrooms: "2" });
    expect(parse({}).drawer).toEqual({ minPrice: "", maxPrice: "", bedrooms: "" });
    expect(parse({ minPrice: ["1", "2"] }).drawer.minPrice).toBe("");
  });

  test("links keep the category, sit between guests and the filters, and a change goes to page 1", () => {
    const state = { dest: "Goa", guests: 2, category: "beach", minPrice: 500 };
    expect(listingsUrl(state)).toBe("/listings?dest=Goa&guests=2&category=beach&minPrice=500");
    expect(listingsUrl({ ...state, page: 3 }, { category: "cabins" })).toBe(
      "/listings?dest=Goa&guests=2&category=cabins&minPrice=500",
    );
  });

  test("the search form carries the category in a hidden input", () => {
    const names = hiddenFields({ dest: "Goa", category: "beach" }, ["dest", "in", "out", "guests"]);
    expect(names).toEqual([["category", "beach"]]);
  });

  test("a URL made from the state parses back to the same state", () => {
    const state = { dest: "Goa", guests: 2, category: "amazing-pools", type: ["villa"], amenities: ["wifi"], instantBook: true };
    const url = new URL(`http://x${listingsUrl(state)}`);
    const query = {};
    for (const [key, value] of url.searchParams) {
      query[key] = key in query ? [].concat(query[key], value) : value;
    }
    expect(parse(query).state).toEqual(state);
  });
});
