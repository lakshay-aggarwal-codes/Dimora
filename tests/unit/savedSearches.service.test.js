// P10-T02: saved searches (in-memory fake, no database). The query that is
// stored comes from the same parser as the listings page.
const searches = require("../../src/services/savedSearches");
const { SEARCH_LIMITS } = require("../../src/config/wishlists");
const { FakeCollection, newId } = require("../helpers/fakeCollection");

const fakeCanon = (params) => (params && params.dest ? `dest=${encodeURIComponent(params.dest)}&guests=2` : "");
const world = () => {
  const SavedSearch = new FakeCollection({ unique: [["owner", "name"]] });
  return { SavedSearch, deps: { SavedSearch, canonicalQuery: fakeCanon }, me: newId(), other: newId() };
};

describe("save", () => {
  test("stores the name and the canonical query; the link re-runs it", async () => {
    const w = world();
    const saved = await searches.save(w.me, { name: " Goa trip ", params: { dest: "Goa" } }, w.deps);
    expect(saved.name).toBe("Goa trip");
    expect(saved.href).toBe("/listings?dest=Goa&guests=2");
    expect(w.SavedSearch.docs[0].query).toBe("dest=Goa&guests=2");
    expect(String(w.SavedSearch.docs[0].owner)).toBe(String(w.me));
  });

  test("an empty search, a bad name, a name in use and too many searches are refused", async () => {
    const w = world();
    await expect(searches.save(w.me, { name: "x", params: {} }, w.deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(searches.save(w.me, { name: " ", params: { dest: "Goa" } }, w.deps)).rejects.toMatchObject({ statusCode: 400 });
    await searches.save(w.me, { name: "A", params: { dest: "Goa" } }, w.deps);
    await expect(searches.save(w.me, { name: "A", params: { dest: "Pune" } }, w.deps)).rejects.toMatchObject({ statusCode: 409, code: "name_taken" });
    for (let i = 1; i < SEARCH_LIMITS.maxSaved; i += 1) await searches.save(w.me, { name: `S${i}`, params: { dest: "Goa" } }, w.deps);
    await expect(searches.save(w.me, { name: "Last", params: { dest: "Goa" } }, w.deps)).rejects.toMatchObject({ statusCode: 409, code: "too_many_searches" });
    // another member has their own allowance and namespace
    await expect(searches.save(w.other, { name: "A", params: { dest: "Goa" } }, w.deps)).resolves.toBeDefined();
  });
});

describe("list and remove", () => {
  test("only the member's own, newest first, with a readable summary", async () => {
    const w = world();
    await searches.save(w.me, { name: "Old", params: { dest: "Goa" } }, w.deps);
    w.SavedSearch.docs[0].createdAt = new Date("2026-01-01");
    await searches.save(w.me, { name: "New", params: { dest: "Pune" } }, w.deps);
    await searches.save(w.other, { name: "Theirs", params: { dest: "Delhi" } }, w.deps);
    const got = await searches.list(w.me, w.deps);
    expect(got.map((s) => s.name)).toEqual(["New", "Old"]);
    expect(got[0].href).toBe("/listings?dest=Pune&guests=2");
    expect(got[0].summary).toBe("Pune · 2 guests");
  });

  test("delete: own only; someone else's or a bad id is a 404", async () => {
    const w = world();
    const mine = await searches.save(w.me, { name: "A", params: { dest: "Goa" } }, w.deps);
    await expect(searches.remove(w.other, mine.id, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(searches.remove(w.me, "nope", w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(searches.remove(w.me, mine.id, w.deps)).resolves.toEqual({ removed: true });
    await expect(searches.remove(w.me, mine.id, w.deps)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("describeQuery", () => {
  test("dates, guests, price and other filters in a short line", () => {
    expect(searches.describeQuery("dest=Goa&in=2026-12-01&out=2026-12-04&guests=1")).toBe("Goa · 2026-12-01 to 2026-12-04 · 1 guest");
    expect(searches.describeQuery("minPrice=1000&maxPrice=5000&amenities=wifi&amenities=pool")).toBe("price 1000 to 5000 · 1 more filter");
    expect(searches.describeQuery("sort=price_asc")).toBe("All stays");
  });
});

describe("canonicalQuery (the real parser)", () => {
  test("only valid, known parameters, in a fixed order, without page, name or the CSRF token", () => {
    const q = searches.canonicalQuery({ guests: "2", dest: "Goa", page: "3", name: "x", _csrf: "t", evil: "<script>" });
    expect(q).toBe("dest=Goa&guests=2");
  });

  test("a wrong value is dropped and nothing valid gives an empty query", () => {
    expect(searches.canonicalQuery({ guests: "abc" })).toBe("");
    expect(searches.canonicalQuery({})).toBe("");
    expect(searches.canonicalQuery(undefined)).toBe("");
  });

  test("everything in the result is URL-encoded", () => {
    const q = searches.canonicalQuery({ dest: "Goa & <b>Pune</b>" });
    expect(q).not.toMatch(/[<>"' ]/);
    expect(new URLSearchParams(q).get("dest")).toBe("Goa & <b>Pune</b>");
  });
});
