// P05-T04: the category strip is a list of rules over real listing fields.
const {
  CATEGORIES,
  CATEGORY_SLUGS,
  getCategory,
  categoryClause,
} = require("../../src/config/categories");
const {
  PROPERTY_TYPE_VALUES,
  ROOM_TYPE_VALUES,
  VIBE_VALUES,
  AMENITY_VALUES,
} = require("../../src/config/constants");

const ALLOWED = {
  vibe: VIBE_VALUES,
  propertyType: PROPERTY_TYPE_VALUES,
  roomType: ROOM_TYPE_VALUES,
  amenities: AMENITY_VALUES,
};

describe("the category list", () => {
  test("slugs are unique, lower-case and safe to put in a URL", () => {
    expect(new Set(CATEGORY_SLUGS).size).toBe(CATEGORIES.length);
    for (const slug of CATEGORY_SLUGS) expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("every category maps to a field the listing model has and to values it allows", () => {
    for (const category of CATEGORIES) {
      expect(Object.keys(ALLOWED)).toContain(category.field);
      expect(category.values.length).toBeGreaterThan(0);
      for (const value of category.values) {
        expect({ slug: category.slug, ok: ALLOWED[category.field].includes(value) }).toEqual({
          slug: category.slug,
          ok: true,
        });
      }
      expect(category.label).toBeTruthy();
      expect(category.icon).toMatch(/^fa-[a-z-]+$/);
    }
  });

  test("categories the data cannot back are not offered", () => {
    for (const slug of ["trending", "castles", "skiing", "arctic", "camping", "design"]) {
      expect(CATEGORY_SLUGS).not.toContain(slug);
    }
  });

  test("the list cannot be changed by other code", () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true);
    expect(Object.isFrozen(CATEGORIES[0])).toBe(true);
    expect(Object.isFrozen(CATEGORIES[0].values)).toBe(true);
  });
});

describe("getCategory", () => {
  test("finds a category by slug", () => {
    expect(getCategory("beach").field).toBe("vibe");
    expect(getCategory("farm-stays").values).toEqual(["farm_stay"]);
  });

  test.each([undefined, null, "", "nope", "BEACH", { slug: "beach" }, 7, "__proto__", "constructor", "toString"])(
    "%p is not a category",
    (value) => {
      expect(getCategory(value)).toBeNull();
    },
  );

  test("a list (what ?category=a&category=b gives) is not a category", () => {
    expect(getCategory(["beach"])).toBeNull();
    expect(getCategory(["beach", "cabins"])).toBeNull();
  });
});

describe("categoryClause", () => {
  test("a setting or a property type is one `$in` over that field", () => {
    expect(categoryClause("beach")).toEqual({ vibe: { $in: ["beach"] } });
    expect(categoryClause("mountains")).toEqual({ vibe: { $in: ["mountain"] } });
    expect(categoryClause("cabins")).toEqual({ propertyType: { $in: ["cabin"] } });
    expect(categoryClause("farm-stays")).toEqual({ propertyType: { $in: ["farm_stay"] } });
  });

  test("Rooms means a private or a shared room", () => {
    expect(categoryClause("rooms")).toEqual({
      roomType: { $in: ["private_room", "shared_room"] },
    });
  });

  test("Amazing pools means the listing has a pool", () => {
    expect(categoryClause("amazing-pools")).toEqual({ amenities: { $all: ["pool"] } });
  });

  test("an unknown slug has no clause, and the clause is a copy", () => {
    expect(categoryClause("nope")).toBeNull();
    const clause = categoryClause("beach");
    clause.vibe.$in.push("city");
    expect(categoryClause("beach")).toEqual({ vibe: { $in: ["beach"] } });
  });
});
