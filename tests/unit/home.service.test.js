// P03-T05: pure parts of the home page data (no database, no Express).
const { pickDestinations, loadHomeData } = require("../../src/services/home");
const { toCardItem } = require("../../src/utils/listingCard");

const L = (location, country, extra = {}) => ({
  _id: `id-${Math.random()}`,
  title: "t",
  location,
  country,
  ...extra,
});

describe("pickDestinations", () => {
  test("groups case-insensitively, busiest first, ties by name", () => {
    const out = pickDestinations([
      L("Goa", "India"),
      L("goa ", "india"),
      L("Manali", "India"),
      L("Agra", "India"),
      L("Goa", "India"),
    ]);
    expect(out.map((d) => [d.label, d.count])).toEqual([
      ["Goa, India", 3],
      ["Agra, India", 1],
      ["Manali, India", 1],
    ]);
    expect(out[0].search).toBe("Goa");
  });

  test("skips listings without a location; label without a country", () => {
    const out = pickDestinations([L(undefined, "India"), L("  ", "x"), L("Paris")]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Paris");
  });

  test("the same place in two countries stays separate", () => {
    expect(pickDestinations([L("Paris", "France"), L("Paris", "USA")])).toHaveLength(2);
  });

  test("uses the first image found and respects the limit", () => {
    const out = pickDestinations(
      [
        L("A", "x"),
        L("A", "x", { image: { url: "https://img/1.jpg" } }),
        L("B", "x"),
        L("C", "x"),
      ],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0].imageUrl).toBe("https://img/1.jpg");
  });

  test("empty input and limit 0 give []", () => {
    expect(pickDestinations([])).toEqual([]);
    expect(pickDestinations([L("A", "x")], 0)).toEqual([]);
  });
});

describe("toCardItem", () => {
  test("paise pass through; a missing, fractional or negative price becomes null", () => {
    const item = (pricing) => toCardItem({ _id: 1, title: "t", pricing });
    expect(item({ nightlyMinor: 120000 }).priceMinor).toBe(120000);
    expect(item({ nightlyMinor: 0 }).priceMinor).toBe(0);
    for (const bad of [undefined, null, "12", NaN, 12.5, -5]) {
      expect(item({ nightlyMinor: bad }).priceMinor).toBeNull();
    }
    expect(item(undefined).priceMinor).toBeNull();
  });

  test("maps a listing, tolerating a missing image and a null listing", () => {
    expect(
      toCardItem({
        _id: 7,
        title: "A",
        pricing: { nightlyMinor: 1000, currency: "INR" },
        location: "L",
        country: "C",
      }),
    ).toEqual({
      id: "7",
      title: "A",
      imageUrl: null,
      location: "L",
      country: "C",
      priceMinor: 1000,
      currency: "INR",
    });
    expect(toCardItem(null).priceMinor).toBeNull();
  });
});

describe("loadHomeData", () => {
  function model(docs) {
    const calls = {};
    const q = {};
    for (const m of ["select", "sort", "limit", "lean"]) {
      q[m] = (...args) => {
        calls[m] = args;
        return q;
      };
    }
    q.then = (res, rej) => Promise.resolve(docs).then(res, rej);
    return { find: () => q, calls };
  }

  test("asks for the newest listings, bounded, and returns at most 6 cards", async () => {
    const docs = Array.from({ length: 10 }, (_, i) => L("Goa", "India", { pricing: { nightlyMinor: 10000 + i } }));
    const m = model(docs);
    const out = await loadHomeData(m);
    expect(out.featured).toHaveLength(6);
    expect(out.destinations[0].count).toBe(10);
    expect(m.calls.sort).toEqual([{ _id: -1 }]);
    expect(m.calls.limit).toEqual([100]);
  });

  test("a non-array result is treated as empty", async () => {
    expect(await loadHomeData(model(null))).toEqual({
      featured: [],
      destinations: [],
    });
  });
});
