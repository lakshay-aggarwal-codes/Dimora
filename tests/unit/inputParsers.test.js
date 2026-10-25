// P17-T02: every request parser and form schema is fed operator objects,
// duplicate parameters, NUL bytes and huge strings in each field. Each must
// either answer with a validation error (400) or return plain values: never an
// object that could reach a database filter, never a crash.
const { parseQuoteQuery } = require("../../src/validation/quoteQuery");
const { parseCompareQuery } = require("../../src/validation/compareQuery");
const { parseListingQuery } = require("../../src/validation/searchQuery");
const { listingSchema, reviewSchema, signupSchema } = require("../../src/validation");
const { validateProfile, profileSchema } = require("../../src/validation/profile");

const PAYLOADS = [
  { $ne: "x" },
  { $gt: "" },
  { $regex: ".*" },
  [{ $ne: 1 }],
  ["2026-12-01", "2026-12-02"], // a repeated parameter (HPP)
  "a\u0000b",
  "x".repeat(200000),
  { a: { b: { c: 1 } } },
  1e308,
  true,
  null,
];

const isPlain = (v) =>
  v === null ||
  ["string", "number", "boolean"].includes(typeof v) ||
  v instanceof Date ||
  (Array.isArray(v) && v.every(isPlain));
const noOperators = (v) => !JSON.stringify(v === undefined ? null : v).includes('"$');

function mustBeSafe(run, label) {
  let result;
  try {
    result = run();
  } catch (err) {
    // The only acceptable failure is a plain 400.
    expect(`${label}: ${err && err.statusCode}`).toBe(`${label}: 400`);
    return;
  }
  expect(`${label}: ${noOperators(result)}`).toBe(`${label}: true`);
}

describe("query parsers", () => {
  const ids = "6720a0000000000000000001,6720a0000000000000000002";

  test("parseQuoteQuery", () => {
    for (const key of ["in", "out", "guests"]) {
      for (const payload of PAYLOADS) {
        mustBeSafe(
          () => parseQuoteQuery({ in: "2026-12-01", out: "2026-12-04", guests: "2", [key]: payload }),
          `quote.${key}`,
        );
      }
    }
  });

  test("parseCompareQuery", () => {
    for (const key of ["ids", "in", "out", "guests", "place"]) {
      for (const payload of PAYLOADS) {
        mustBeSafe(() => parseCompareQuery({ ids, in: "2026-12-01", out: "2026-12-04", [key]: payload }), `compare.${key}`);
      }
    }
  });

  test("parseListingQuery never throws and keeps only plain values in what it hands to the search", () => {
    const keys = ["dest", "destination", "search", "in", "out", "guests", "minPrice", "maxPrice", "bedrooms", "minRating", "sort", "page", "type", "amenities", "bbox"];
    for (const key of keys) {
      for (const payload of PAYLOADS) {
        let parsed;
        try {
          parsed = parseListingQuery({ [key]: payload });
        } catch (err) {
          expect(`listings.${key}: ${err && err.statusCode}`).toBe(`listings.${key}: 400`);
          continue;
        }
        for (const [name, value] of Object.entries(parsed.searchParams)) {
          expect(`listings.${key}.${name}: ${isPlain(value)}`).toBe(`listings.${key}.${name}: true`);
        }
        expect(`listings.${key}: ${noOperators(parsed.searchParams)}`).toBe(`listings.${key}: true`);
      }
    }
  });
});

describe("form schemas", () => {
  // A field is fine if the schema complains about it, or if what it keeps is plain.
  const check = (name, schema) => {
    const keys = Object.keys(schema.describe().keys || {});
    for (const key of keys) {
      for (const payload of PAYLOADS) {
        const { error, value } = schema.validate({ [key]: payload }, { abortEarly: false });
        const complained = Boolean(error) && error.details.some((d) => d.path[0] === key);
        if (!complained) {
          expect(`${name}.${key}: ${isPlain(value[key])}`).toBe(`${name}.${key}: true`);
        }
      }
    }
  };

  test("listing, review, signup and profile reject operator objects field by field", () => {
    check("listing", listingSchema);
    check("review", reviewSchema);
    check("signup", signupSchema);
    check("profile", profileSchema);
  });

  test("validateProfile never lets an object through as text", () => {
    const { value, errors } = validateProfile({ displayName: { $ne: "x" }, bio: ["a", "b"] });
    expect(JSON.stringify(value || {}).includes('"$')).toBe(false);
    expect(typeof errors).toBe("object");
  });
});
