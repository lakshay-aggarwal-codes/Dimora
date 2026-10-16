// P04-T02: what each wizard step accepts and refuses (no database).
const { validateStep } = require("../../src/validation/wizard");

const basics = (extra = {}) => ({
  title: "Sunny flat by the sea",
  description: "A bright two-room flat a minute from the beach.",
  propertyType: "apartment",
  roomType: "entire_place",
  ...extra,
});
const location = (extra = {}) => ({
  line1: "12 Beach Road",
  city: "Goa",
  state: "Goa",
  country: "India",
  postalCode: "403001",
  ...extra,
});
const details = (extra = {}) => ({
  guests: "4",
  bedrooms: "2",
  beds: "3",
  bathrooms: "1.5",
  amenities: ["wifi", "kitchen"],
  ...extra,
});
const pricing = (extra = {}) => ({
  price: "2500",
  cleaningFee: "300",
  minNights: "1",
  maxNights: "30",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "moderate",
  instantBook: "on",
  houseRules: "No smoking.",
  ...extra,
});

const bad = (step, body) => Object.keys(validateStep(step, body).errors);

describe("step 1: basics", () => {
  test("valid input is trimmed and returned", () => {
    const { value, errors } = validateStep(1, basics({ title: "  Sunny flat by the sea  " }));
    expect(errors).toEqual({});
    expect(value.title).toBe("Sunny flat by the sea");
  });

  test("missing or short title and description, and unknown types, are refused with a message each", () => {
    const { errors, value } = validateStep(1, {
      title: "Hi",
      description: "too short",
      propertyType: "castle",
    });
    expect(value).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(
      ["description", "propertyType", "roomType", "title"].sort(),
    );
    expect(errors.title).toMatch(/at least 5/);
    expect(errors.roomType).toMatch(/Choose/);
  });

  test("a title over 100 characters and a description over 3000 are refused", () => {
    expect(bad(1, basics({ title: "x".repeat(101) }))).toEqual(["title"]);
    expect(bad(1, basics({ description: "x".repeat(3001) }))).toEqual(["description"]);
    expect(bad(1, basics({ title: "x".repeat(100) }))).toEqual([]);
  });

  test("a field that is not part of the step is refused, not ignored", () => {
    expect(bad(1, basics({ status: "published" }))).not.toEqual([]);
    expect(bad(1, basics({ owner: "someone" }))).not.toEqual([]);
  });

  test("whitespace-only fields count as empty", () => {
    expect(bad(1, basics({ title: "     " }))).toEqual(["title"]);
  });
});

describe("step 2: location", () => {
  test("accepts a full address; state and postal code are optional", () => {
    expect(bad(2, location())).toEqual([]);
    expect(bad(2, location({ state: "", postalCode: "" }))).toEqual([]);
    expect(bad(2, { state: "Goa" }).sort()).toEqual(["city", "country", "line1"]);
  });

  test("length limits", () => {
    expect(bad(2, location({ line1: "x".repeat(201) }))).toEqual(["line1"]);
    expect(bad(2, location({ postalCode: "1".repeat(21) }))).toEqual(["postalCode"]);
  });
});

describe("step 3: rooms and amenities", () => {
  test("valid; amenities may be one value, several, or none", () => {
    expect(validateStep(3, details()).errors).toEqual({});
    expect(validateStep(3, details({ amenities: "wifi" })).value.amenities).toEqual(["wifi"]);
    expect(validateStep(3, details({ amenities: undefined })).value.amenities).toEqual([]);
  });

  test("guests 1 to 16, whole numbers", () => {
    for (const guests of ["0", "17", "2.5", "abc", ""]) {
      expect(bad(3, details({ guests }))).toEqual(["guests"]);
    }
    expect(bad(3, details({ guests: "16" }))).toEqual([]);
  });

  test("bathrooms: whole or half numbers only", () => {
    expect(bad(3, details({ bathrooms: "1.3" }))).toEqual(["bathrooms"]);
    expect(bad(3, details({ bathrooms: "-1" }))).toEqual(["bathrooms"]);
    expect(bad(3, details({ bathrooms: "2" }))).toEqual([]);
  });

  test("unknown or repeated amenities are refused", () => {
    expect(bad(3, details({ amenities: ["wifi", "jetpack"] }))).toEqual(["amenities"]);
    expect(bad(3, details({ amenities: ["wifi", "wifi"] }))).toEqual(["amenities"]);
  });
});

describe("step 5: price and rules", () => {
  test("valid; the checkbox and an empty cleaning fee have sensible defaults", () => {
    const { value, errors } = validateStep(
      5,
      pricing({ cleaningFee: "", instantBook: undefined, houseRules: undefined }),
    );
    expect(errors).toEqual({});
    expect(value.cleaningFee).toBe(0);
    expect(value.instantBook).toBe(false);
    expect(value.houseRules).toBe("");
    expect(validateStep(5, pricing()).value.instantBook).toBe(true);
  });

  test("the nightly price is INR 100 to 10 lakh", () => {
    for (const price of ["99", "99.99", "1000001", "free", ""]) {
      expect(bad(5, pricing({ price }))).toEqual(["price"]);
    }
    expect(bad(5, pricing({ price: "100" }))).toEqual([]);
    expect(bad(5, pricing({ price: "1000000" }))).toEqual([]);
  });

  test("the cleaning fee cannot be negative", () => {
    expect(bad(5, pricing({ cleaningFee: "-1" }))).toEqual(["cleaningFee"]);
  });

  test("minimum nights cannot be more than maximum nights (shown by the minimum field)", () => {
    const { errors } = validateStep(5, pricing({ minNights: "5", maxNights: "2" }));
    expect(Object.keys(errors)).toEqual(["minNights"]);
    expect(errors.minNights).toMatch(/cannot be more than/);
    expect(bad(5, pricing({ minNights: "3", maxNights: "3" }))).toEqual([]);
  });

  test("nights are whole numbers from 1 to 365", () => {
    expect(bad(5, pricing({ minNights: "0" }))).toEqual(["minNights"]);
    expect(bad(5, pricing({ maxNights: "366" }))).toEqual(["maxNights"]);
    expect(bad(5, pricing({ minNights: "1.5" }))).toEqual(["minNights"]);
  });

  test("times look like HH:MM; the policy comes from the list", () => {
    for (const checkInTime of ["9:00", "24:00", "noon", "12:60", ""]) {
      expect(bad(5, pricing({ checkInTime }))).toEqual(["checkInTime"]);
    }
    expect(bad(5, pricing({ cancellationPolicy: "whenever" }))).toEqual(["cancellationPolicy"]);
  });
});

test("steps 4 and 6 have no form", () => {
  expect(() => validateStep(4, {})).toThrow(/No form/);
  expect(() => validateStep(6, {})).toThrow(/No form/);
});
