// P04-T05: the Host Readiness Checklist as a pure function (no database).
const { evaluateReadiness } = require("../../src/services/readiness");
const { READINESS } = require("../../src/config/constants");

const photo = (n) => ({
  url: `https://res.cloudinary.test/p${n}.jpg`,
  publicId: `p${n}`,
});
const READY = () => ({
  images: [1, 2, 3, 4, 5].map(photo),
  description: "x".repeat(200),
  address: { line1: "12 Beach Road", city: "Goa", country: "India" },
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
  needsReview: false,
  capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
  pricing: { nightlyMinor: 250000 },
  houseRules: "No smoking.",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "moderate",
});
const failed = (listing, options) =>
  evaluateReadiness(listing, options)
    .checks.filter((c) => !c.passed)
    .map((c) => c.key);

describe("evaluateReadiness", () => {
  test("a complete listing: score 100 and can be published", () => {
    const r = evaluateReadiness(READY());
    expect(r.score).toBe(100);
    expect(r.canPublish).toBe(true);
    expect(r.checks).toHaveLength(8);
    expect(r.checks.every((c) => c.passed && c.hint === "")).toBe(true);
  });

  test("an empty listing: score 0, nothing passes, nothing throws", () => {
    for (const input of [{}, undefined, null]) {
      const r = evaluateReadiness(input);
      expect(r.score).toBe(0);
      expect(r.canPublish).toBe(false);
      expect(r.checks.every((c) => !c.passed && c.hint.length > 0)).toBe(true);
    }
  });

  test("every check has a key, a label, a hint when failing and a wizard step", () => {
    const r = evaluateReadiness({});
    expect(r.checks.map((c) => c.key)).toEqual([
      "photos",
      "description",
      "address",
      "capacity",
      "price",
      "rules",
      "times",
      "cancellation",
    ]);
    for (const c of r.checks) {
      expect(typeof c.label).toBe("string");
      expect(c.step).toBeGreaterThanOrEqual(1);
      expect(c.step).toBeLessThanOrEqual(5);
    }
  });

  describe("photos (default 5)", () => {
    test.each([
      [0, false],
      [4, false],
      [5, true],
      [9, true],
    ])("%i photos -> %s", (n, ok) => {
      const l = {
        ...READY(),
        images: Array.from({ length: n }, (_, i) => photo(i + 1)),
      };
      expect(failed(l).includes("photos")).toBe(!ok);
    });
    test("entries without a url do not count", () => {
      const l = {
        ...READY(),
        images: [
          photo(1),
          photo(2),
          photo(3),
          photo(4),
          { publicId: "x" },
          null,
        ],
      };
      expect(failed(l)).toContain("photos");
    });
    test("the hint says how many are missing", () => {
      const l = { ...READY(), images: [photo(1), photo(2)] };
      const hint = evaluateReadiness(l).checks.find(
        (c) => c.key === "photos",
      ).hint;
      expect(hint).toBe("You have 2. Add 3 more photos.");
    });
    test("the minimum is configurable", () => {
      const l = { ...READY(), images: [photo(1), photo(2)] };
      expect(failed(l, { minPhotos: 2 })).not.toContain("photos");
      expect(failed(l, { minPhotos: 3 })).toContain("photos");
    });
  });

  describe("description (default 200 characters)", () => {
    test.each([
      [199, false],
      [200, true],
      [5000, true],
    ])("%i characters -> %s", (n, ok) => {
      expect(
        failed({ ...READY(), description: "a".repeat(n) }).includes(
          "description",
        ),
      ).toBe(!ok);
    });
    test("surrounding spaces do not count", () => {
      expect(
        failed({
          ...READY(),
          description: `  ${"a".repeat(150)}  ${" ".repeat(100)}`,
        }),
      ).toContain("description");
    });
    test("not a string -> fails, does not throw", () => {
      for (const description of [undefined, null, 5, {}, []]) {
        expect(failed({ ...READY(), description })).toContain("description");
      }
    });
    test("it only counts characters, not quality (documented)", () => {
      expect(
        failed({ ...READY(), description: "blah ".repeat(41) }),
      ).not.toContain("description");
    });
  });

  describe("address", () => {
    test.each([
      ["no street", { address: { city: "Goa", country: "India" } }],
      ["no city", { address: { line1: "1 Road", country: "India" } }],
      ["no country", { address: { line1: "1 Road", city: "Goa" } }],
      [
        "blank street",
        { address: { line1: "   ", city: "Goa", country: "India" } },
      ],
      ["no point", { geometry: undefined }],
      ["empty coordinates", { geometry: { type: "Point", coordinates: [] } }],
      [
        "non-numeric coordinates",
        { geometry: { type: "Point", coordinates: ["a", "b"] } },
      ],
      ["marked for review", { needsReview: true }],
    ])("%s fails", (_name, patch) => {
      expect(failed({ ...READY(), ...patch })).toContain("address");
    });
    test("a missing needsReview flag is fine", () => {
      const l = READY();
      delete l.needsReview;
      expect(failed(l)).not.toContain("address");
    });
  });

  describe("capacity", () => {
    test.each([
      [{ guests: 0, beds: 1 }, true],
      [{ guests: 2, beds: 0 }, true],
      [{ guests: 1.5, beds: 1 }, true],
      [{ guests: "2", beds: 1 }, true],
      [{ guests: 1, beds: 1 }, false],
      [{ guests: 16, beds: 20 }, false],
    ])("%j -> fails: %s", (capacity, fails) => {
      expect(failed({ ...READY(), capacity }).includes("capacity")).toBe(fails);
    });
    test("a studio (0 bedrooms) is fine", () => {
      expect(
        failed({
          ...READY(),
          capacity: { guests: 2, bedrooms: 0, beds: 1, bathrooms: 1 },
        }),
      ).not.toContain("capacity");
    });
  });

  describe("price", () => {
    test.each([
      [undefined, true],
      [null, true],
      [0, true],
      [-5, true],
      [1.5, true],
      ["2500", true],
      [10000, false],
    ])("%p -> fails: %s", (nightlyMinor, fails) => {
      expect(
        failed({ ...READY(), pricing: { nightlyMinor } }).includes("price"),
      ).toBe(fails);
    });
    test("no pricing object at all", () => {
      const l = READY();
      delete l.pricing;
      expect(failed(l)).toContain("price");
    });
  });

  describe("house rules", () => {
    test("written rules pass", () => {
      expect(
        failed({ ...READY(), houseRules: "Quiet after 10 pm." }),
      ).not.toContain("rules");
    });
    test('"no special rules" confirmed passes', () => {
      expect(
        failed({ ...READY(), houseRules: "", noSpecialRules: true }),
      ).not.toContain("rules");
      expect(
        failed({ ...READY(), houseRules: undefined, noSpecialRules: true }),
      ).not.toContain("rules");
    });
    test("neither fails", () => {
      expect(
        failed({ ...READY(), houseRules: "   ", noSpecialRules: false }),
      ).toContain("rules");
      expect(failed({ ...READY(), houseRules: undefined })).toContain("rules");
    });
    test("only a real true confirms (not 'on', not 1)", () => {
      expect(
        failed({ ...READY(), houseRules: "", noSpecialRules: "on" }),
      ).toContain("rules");
      expect(
        failed({ ...READY(), houseRules: "", noSpecialRules: 1 }),
      ).toContain("rules");
    });
  });

  describe("check-in / check-out times", () => {
    test.each([
      [{ checkInTime: "14:00", checkOutTime: "11:00" }, false],
      [{ checkInTime: "00:00", checkOutTime: "23:59" }, false],
      [{ checkInTime: "24:00", checkOutTime: "11:00" }, true],
      [{ checkInTime: "9:00", checkOutTime: "11:00" }, true],
      [{ checkInTime: "14:00", checkOutTime: "" }, true],
      [{ checkInTime: undefined, checkOutTime: undefined }, true],
      [{ checkInTime: "14:60", checkOutTime: "11:00" }, true],
    ])("%j -> fails: %s", (times, fails) => {
      expect(failed({ ...READY(), ...times }).includes("times")).toBe(fails);
    });
  });

  describe("cancellation policy", () => {
    test.each([
      ["flexible", false],
      ["moderate", false],
      ["strict", false],
      ["generous", true],
      ["", true],
      [undefined, true],
      ["__proto__", true],
    ])("%p -> fails: %s", (cancellationPolicy, fails) => {
      expect(
        failed({ ...READY(), cancellationPolicy }).includes("cancellation"),
      ).toBe(fails);
    });
  });

  test("the score is the share of items done", () => {
    const l = { ...READY(), images: [], description: "" }; // 2 of 8 fail
    const r = evaluateReadiness(l);
    expect(r.score).toBe(75);
    expect(r.canPublish).toBe(false);
  });

  test("score 100 if and only if canPublish", () => {
    const base = READY();
    const variants = [
      base,
      { ...base, images: [] },
      { ...base, noSpecialRules: true, houseRules: "" },
      { ...base, cancellationPolicy: "x" },
    ];
    for (const v of variants) {
      const r = evaluateReadiness(v);
      expect(r.canPublish).toBe(r.score === 100);
      expect(r.canPublish).toBe(r.checks.every((c) => c.passed));
    }
  });

  test("defaults come from the shared constants", () => {
    expect(READINESS).toEqual({ minPhotos: 5, minDescriptionChars: 200 });
  });

  test("a Mongoose-like document works the same as a plain object", () => {
    const Listing = require("../../src/models/listing");
    const doc = new Listing({
      title: "T",
      status: "draft",
      owner: "64b0f0f0f0f0f0f0f0f0aaaa",
      images: [1, 2, 3, 4, 5].map(photo),
      description: "x".repeat(200),
      address: { line1: "12 Beach Road", city: "Goa", country: "India" },
      geometry: { type: "Point", coordinates: [73.8, 15.5] },
      needsReview: false,
      capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
      pricing: { nightlyMinor: 250000 },
      noSpecialRules: true,
    });
    expect(evaluateReadiness(doc).canPublish).toBe(true);
  });
});
