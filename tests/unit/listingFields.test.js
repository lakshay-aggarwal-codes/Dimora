// P04-T01: conversions used by the old listing form, the controllers and the seed.
const {
  rupeesToMinor,
  minorToRupees,
  addressFromLegacy,
  imagesFromCover,
} = require("../../src/utils/listingFields");

test("rupeesToMinor: whole and fractional rupees become integer paise", () => {
  expect(rupeesToMinor(2500)).toBe(250000);
  expect(rupeesToMinor("2500")).toBe(250000);
  expect(rupeesToMinor(1234.56)).toBe(123456);
  expect(rupeesToMinor(19.99)).toBe(1999);
  expect(Number.isInteger(rupeesToMinor(0.1 + 0.2))).toBe(true);
});

test("rupeesToMinor: anything that is not a non-negative number is null", () => {
  for (const bad of [undefined, null, "", "abc", NaN, Infinity, -1, {}, []]) {
    expect(rupeesToMinor(bad)).toBeNull();
  }
});

test("minorToRupees reverses it and returns null for non-integers", () => {
  expect(minorToRupees(250000)).toBe(2500);
  expect(minorToRupees(123456)).toBe(1234.56);
  for (const bad of [undefined, null, 12.5, "100"]) {
    expect(minorToRupees(bad)).toBeNull();
  }
});

test("addressFromLegacy trims, skips blanks and never returns undefined fields", () => {
  expect(addressFromLegacy("  Goa ", " India")).toEqual({
    city: "Goa",
    country: "India",
  });
  expect(addressFromLegacy("Goa", "")).toEqual({ city: "Goa" });
  expect(addressFromLegacy(undefined, null)).toEqual({});
});

test("imagesFromCover gives one entry, or none when there is no usable cover", () => {
  expect(imagesFromCover({ url: "https://i/a.jpg", filename: "f" })).toEqual([
    { url: "https://i/a.jpg", publicId: "f", alt: "", caption: "", order: 0 },
  ]);
  expect(imagesFromCover({ url: "https://i/a.jpg" })[0].publicId).toBe("");
  for (const bad of [undefined, null, {}, { url: "" }, { url: 5 }]) {
    expect(imagesFromCover(bad)).toEqual([]);
  }
});
