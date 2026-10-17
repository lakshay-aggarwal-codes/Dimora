// P05-T01: what search parameters are accepted, and operator-injection payloads
// (no database). Joi does the coercion; objects and lists never get through.
const { parseSearchParams } = require("../../src/validation/search");

const ok = (query) => {
  const result = parseSearchParams(query);
  expect(result.errors).toEqual({});
  return result.value;
};
const errorKeys = (query) => Object.keys(parseSearchParams(query).errors);

test("an empty query is valid and means no filters", () => {
  expect(ok({})).toEqual({});
  expect(ok(undefined)).toEqual({});
  expect(ok(null)).toEqual({});
  expect(ok("string")).toEqual({});
});

test("strings from the URL become numbers and booleans", () => {
  expect(
    ok({
      destination: "  Goa ",
      minPrice: "1000",
      maxPrice: "5000.5",
      guests: "4",
      bedrooms: "2",
      instantBook: "1",
    }),
  ).toEqual({
    destination: "Goa",
    minPrice: 1000,
    maxPrice: 5000.5,
    guests: 4,
    bedrooms: 2,
    instantBook: true,
  });
});

test("empty values mean 'not set'", () => {
  expect(ok({ destination: "", keywords: "  ", minPrice: "", guests: "", instantBook: "" })).toEqual({
    instantBook: false,
  });
});

test("lists: one value or several, from the allowed choices only", () => {
  expect(ok({ propertyType: "villa" }).propertyType).toEqual(["villa"]);
  expect(ok({ amenities: ["wifi", "pool"] }).amenities).toEqual(["wifi", "pool"]);
  expect(errorKeys({ propertyType: "castle" })).toEqual(["propertyType"]);
  expect(errorKeys({ amenities: ["wifi", "wifi"] })).toEqual(["amenities"]);
  expect(errorKeys({ roomType: ["entire_place", "jetpack"] })).toEqual(["roomType"]);
});

test("numbers have sensible limits", () => {
  for (const query of [
    { guests: "0" },
    { guests: "17" },
    { guests: "2.5" },
    { guests: "abc" },
    { bedrooms: "-1" },
    { minPrice: "-5" },
    { maxPrice: "1000001" },
    { minPrice: "x" },
  ]) {
    expect(errorKeys(query)).toEqual([Object.keys(query)[0]]);
  }
});

test("the minimum price cannot be above the maximum; the rest of the query still works", () => {
  const result = parseSearchParams({ minPrice: "5000", maxPrice: "1000", guests: "2" });
  expect(Object.keys(result.errors)).toEqual(["maxPrice"]);
  expect(result.errors.maxPrice).toMatch(/cannot be more than/);
  expect(result.value).toEqual({ minPrice: 5000, guests: 2 });
});

test("a bad parameter does not spoil the good ones", () => {
  const result = parseSearchParams({ destination: "Goa", guests: "abc", amenities: "wifi" });
  expect(Object.keys(result.errors)).toEqual(["guests"]);
  expect(result.value).toEqual({ destination: "Goa", amenities: ["wifi"] });
});

describe("operator injection", () => {
  const payloads = [
    { guests: { $gt: "0" } },
    { guests: { $ne: null } },
    { minPrice: { $gt: 0 } },
    { maxPrice: { $regex: ".*" } },
    { destination: { $regex: ".*" } },
    { destination: { $ne: "x" } },
    { keywords: { $where: "sleep(1000)" } },
    { propertyType: { $ne: "villa" } },
    { propertyType: [{ $ne: "villa" }] },
    { amenities: { $in: ["wifi"] } },
    { instantBook: { $ne: false } },
    { bedrooms: ["1", "2"] }, // ?bedrooms=1&bedrooms=2 (duplicate parameter)
    { guests: ["2", "3"] },
    { destination: ["a", "b"] },
  ];

  test.each(payloads.map((p) => [JSON.stringify(p), p]))("%s is refused and never returned", (_, payload) => {
    const result = parseSearchParams(payload);
    expect(Object.keys(result.errors)).toEqual([Object.keys(payload)[0]]);
    expect(result.value).toEqual({});
  });

  test("operator-looking names are dropped as unknown parameters", () => {
    const result = parseSearchParams({
      "guests[$gt]": "1",
      "price[$gt]": "",
      $where: "1",
      __proto__: { guests: 1 },
      constructor: "x",
      guests: "2",
    });
    expect(result.errors).toEqual({});
    expect(result.value).toEqual({ guests: 2 });
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(({}).guests).toBeUndefined();
  });

  test("a value that is a long string is refused, not truncated into something else", () => {
    expect(errorKeys({ destination: "x".repeat(101) })).toEqual(["destination"]);
    expect(errorKeys({ keywords: "x".repeat(101) })).toEqual(["keywords"]);
  });
});
