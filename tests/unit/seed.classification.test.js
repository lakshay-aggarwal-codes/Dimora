// P05-T04: every sample listing is classified so the category strip has results.
const fs = require("node:fs");
const path = require("node:path");
const { CLASSIFICATION, classificationFor } = require("../../scripts/seed-classification");
const { CATEGORIES } = require("../../src/config/categories");
const {
  PROPERTY_TYPE_VALUES,
  ROOM_TYPE_VALUES,
  VIBE_VALUES,
  AMENITY_VALUES,
} = require("../../src/config/constants");

const titles = [
  ...fs
    .readFileSync(path.join(__dirname, "..", "..", "scripts", "seed-data.js"), "utf8")
    .matchAll(/title: "([^"]+)"/g),
].map((match) => match[1]);

describe("seed classification", () => {
  test("every sample title is classified and nothing else is", () => {
    expect(titles).toHaveLength(29);
    expect(Object.keys(CLASSIFICATION).sort()).toEqual([...titles].sort());
  });

  test("every value is one the listing model accepts", () => {
    for (const title of titles) {
      const fields = classificationFor(title);
      expect(PROPERTY_TYPE_VALUES).toContain(fields.propertyType);
      expect(ROOM_TYPE_VALUES).toContain(fields.roomType);
      expect(VIBE_VALUES).toContain(fields.vibe);
      for (const amenity of fields.amenities) expect(AMENITY_VALUES).toContain(amenity);
    }
  });

  test("a title that is not listed gets nothing, and so does a prototype name", () => {
    expect(classificationFor("Unknown place")).toEqual({});
    expect(classificationFor("constructor")).toEqual({});
  });

  test("the result is a copy", () => {
    const first = classificationFor("Beachfront Paradise");
    first.amenities.push("gym");
    expect(classificationFor("Beachfront Paradise").amenities).toEqual(["wifi", "kitchen", "pool"]);
  });

  test("the demo has results for the categories its data can back", () => {
    const all = titles.map((title) => classificationFor(title));
    const has = (category) =>
      all.some((fields) =>
        category.field === "amenities"
          ? category.values.every((value) => fields.amenities.includes(value))
          : category.values.includes(fields[category.field]),
      );
    const empty = CATEGORIES.filter((category) => !has(category)).map((category) => category.slug);
    // The demo data has no farm stays and no rooms; every other chip has stays.
    expect(empty.sort()).toEqual(["farm-stays", "rooms"]);
  });
});
