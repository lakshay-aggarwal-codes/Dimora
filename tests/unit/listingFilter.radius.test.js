// P06-T05: the shared filter (page + map) with a radius. Needs the real Joi
// validator, so it runs under `npm test` only.
const { listingFilterFor } = require("../../src/services/listingFilter");
const { RADII_KM } = require("../../src/validation/searchQuery");

const GOA = { _id: null, lng: 73.9, lat: 15.4, count: 5 };
const model = (rows) => {
  const calls = [];
  return { calls, aggregate: async (p) => (calls.push(p), rows) };
};
const NOW = new Date("2026-10-29T06:00:00Z");

describe("validation of radius", () => {
  test("only 5, 10, 25 and 50, as plain digits, and only with a destination", async () => {
    expect([...RADII_KM]).toEqual([5, 10, 25, 50]);
    const Listing = model([GOA]);
    const ok = await listingFilterFor({ dest: "Goa", radius: "25" }, { now: NOW, Listing });
    expect(ok.parsed.state.radius).toBe(25);
    expect(ok.parsed.errors.radius).toBeUndefined();
    for (const bad of ["7", "25.0", "-5", "abc", ["10", "25"], { $gt: "1" }, "1e1"]) {
      const r = await listingFilterFor({ dest: "Goa", radius: bad }, { now: NOW, Listing });
      expect(r.parsed.state.radius).toBeUndefined();
      expect(r.parsed.errors.radius).toMatch(/distance can be 5, 10, 25, 50 km/);
      expect(r.parsed.area).toBeNull();
    }
    const noDest = await listingFilterFor({ radius: "25" }, { now: NOW, Listing });
    expect(noDest.parsed.state.radius).toBeUndefined();
    expect(noDest.parsed.errors.radius).toBe("Choose a destination to search around.");
  });
});

describe("listingFilterFor with a radius", () => {
  test("the circle replaces the destination text; the other filters stay", async () => {
    const Listing = model([GOA]);
    const { filter, parsed } = await listingFilterFor({ dest: "Goa", radius: "25", guests: "2" }, { now: NOW, Listing });
    expect(Listing.calls).toHaveLength(1);
    expect(filter.$and).toBeUndefined(); // no destination regexes
    expect(filter["capacity.guests"]).toEqual({ $gte: 2 });
    expect(filter.publicGeometry.$geoWithin.$centerSphere[0]).toEqual([73.9, 15.4]);
    expect(filter.publicGeometry.$geoWithin.$centerSphere[1]).toBeCloseTo(25 / 6378.1, 10);
    expect(parsed.area.km).toBe(25);
    expect(parsed.area.condition).toEqual({ publicGeometry: filter.publicGeometry });
  });

  test("no radius: no extra query and the ordinary destination filter", async () => {
    const Listing = model([GOA]);
    const { filter, parsed } = await listingFilterFor({ dest: "Goa" }, { now: NOW, Listing });
    expect(Listing.calls).toHaveLength(0);
    expect(filter.$and).toHaveLength(1);
    expect(filter.publicGeometry).toBeUndefined();
    expect(parsed.area).toBeNull();
  });

  test("a destination with no stays to centre on keeps the text filter (it finds nothing, honestly)", async () => {
    const Listing = model([]);
    const { filter, parsed } = await listingFilterFor({ dest: "Atlantis", radius: "10" }, { now: NOW, Listing });
    expect(filter.$and).toHaveLength(1);
    expect(filter.publicGeometry).toBeUndefined();
    expect(parsed.area).toBeNull();
  });
});
