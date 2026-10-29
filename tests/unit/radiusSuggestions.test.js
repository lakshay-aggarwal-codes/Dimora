// P06-T05: an empty search with a radius never offers a dead end, and the counts
// use the circle, not the destination text.
const { suggestForEmptyResults, GROUPS } = require("../../src/services/suggestions");

const condition = { publicGeometry: { $geoWithin: { $centerSphere: [[73.8, 15.5], 0.004] } } };
function fake() {
  const filters = [];
  return {
    filters,
    countDocuments: async (f) => (filters.push(f), filters.length), // distinct, positive counts
    find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
  };
}
const parsed = (extra = {}) => ({
  state: { dest: "Goa", radius: 25, guests: 2 },
  searchParams: { destination: "Goa", guests: 2 },
  stay: null,
  area: { km: 25, centre: { lng: 73.8, lat: 15.5, count: 3 }, condition },
  ...extra,
});

describe("suggestions with a radius", () => {
  test("the radius group exists and is active only when the circle was used", () => {
    const g = GROUPS.find((x) => x.key === "radius");
    expect(g.urlKeys).toEqual(["radius"]);
    expect(g.active({ area: {} })).toBe(true);
    expect(g.active({ area: null })).toBe(false);
    expect(g.active({})).toBe(false);
  });

  test("removing the destination removes the radius from the link too", () => {
    expect(GROUPS.find((x) => x.key === "destination").urlKeys).toEqual(["dest", "radius"]);
  });

  test("another filter's count keeps the circle and drops the text match; the radius count is the plain text search", async () => {
    const Listing = fake();
    const result = await suggestForEmptyResults({ Listing, parsed: parsed() });
    const byKey = Object.fromEntries(result.filterSuggestions.map((s) => [s.key, s]));
    expect(byKey.radius.url).toBe("/listings?dest=Goa&guests=2");
    expect(byKey.guests.url).toBe("/listings?dest=Goa&radius=25");
    const [radiusFilter, guestsFilter] = Listing.filters;
    expect(radiusFilter.publicGeometry).toBeUndefined();
    expect(radiusFilter.$and).toBeDefined(); // the destination text is back
    expect(guestsFilter.publicGeometry).toEqual(condition.publicGeometry);
    expect(guestsFilter.$and).toBeUndefined(); // the circle replaced the text match
    expect(guestsFilter["capacity.guests"]).toBeUndefined(); // the guests filter is the one removed
  });
});
