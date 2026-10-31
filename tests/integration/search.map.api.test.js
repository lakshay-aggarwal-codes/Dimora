// P06-T04: GET /api/search/map through the real app. The database is stubbed
// (stubListings), so these check the query that is built and the JSON that is
// returned; search.map.db.test.js checks the same against a real MongoDB.
const { createAgent } = require("../helpers/agent");
const { stubListings } = require("../helpers/listingsStub");

afterEach(() => jest.restoreAllMocks());

const stay = (n, extra = {}) => ({
  _id: `64b00000000000000000${String(n).padStart(4, "0")}`,
  title: `Stay ${n}`,
  pricing: { nightlyMinor: 150000, currency: "INR" },
  publicGeometry: { type: "Point", coordinates: [73.8 + n / 100, 15.5] },
  ...extra,
});
const get = (query = "") => createAgent().get(`/api/search/map${query}`);

describe("GET /api/search/map", () => {
  test("answers a GeoJSON FeatureCollection with the meta block, uncached, without a login", async () => {
    stubListings([stay(1), stay(2)]);
    const res = await get("?bbox=73,15,75,16");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.type).toBe("FeatureCollection");
    expect(res.body.features).toHaveLength(2);
    expect(res.body.features[0].geometry.type).toBe("Point");
    expect(res.body.features[0].properties.priceLabel).toBe("₹1,500");
    expect(res.body.meta).toMatchObject({ total: 2, returned: 2, capped: false, cap: 200 });
  });

  test("the box becomes longitude/latitude ranges on the PUBLIC point", async () => {
    const { calls } = stubListings([stay(1)]);
    await get("?bbox=73,15,75,16");
    expect(calls.countFilter["publicGeometry.type"]).toBe("Point");
    expect(JSON.stringify(calls.countFilter)).toContain("publicGeometry.coordinates.0");
    expect(JSON.stringify(calls.countFilter)).not.toContain('"geometry.');
    const box = calls.countFilter.$and.find((c) => c["publicGeometry.coordinates.0"]);
    expect(box).toEqual({
      "publicGeometry.coordinates.0": { $gte: 73, $lte: 75 },
      "publicGeometry.coordinates.1": { $gte: 15, $lte: 16 },
    });
    expect(calls.projection).not.toHaveProperty("geometry");
  });

  test("a box across the antimeridian becomes two alternatives", async () => {
    const { calls } = stubListings([]);
    await get("?bbox=170,-20,-170,-10");
    const either = calls.countFilter.$and.find((c) => c.$or);
    expect(either.$or).toHaveLength(2);
  });

  test("the page's filters apply: only public listings, destination, guests, price", async () => {
    const { calls } = stubListings([stay(1)]);
    await get("?dest=Goa&guests=3&maxPrice=5000&bbox=73,15,75,16");
    expect(calls.countFilter.status).toBe("published");
    expect(calls.countFilter["capacity.guests"]).toEqual({ $gte: 3 });
    expect(calls.countFilter["pricing.nightlyMinor"]).toEqual({ $lte: 500000 });
    expect(JSON.stringify(calls.countFilter)).toContain("cityKey");
  });

  test("a wrong filter value is ignored, like on the page, and does not stop the map", async () => {
    stubListings([stay(1)]);
    const res = await get("?guests=abc&bbox=73,15,75,16");
    expect(res.status).toBe(200);
    // An operator-shaped value is refused by the input guard (P17-T02), not ignored.
    expect((await get("?minPrice[$gt]=1&bbox=73,15,75,16")).status).toBe(400);
  });

  test("without bbox it covers every place", async () => {
    const { calls } = stubListings([stay(1)]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(JSON.stringify(calls.countFilter)).not.toContain("publicGeometry.coordinates");
  });

  test.each([
    ["not four numbers", "?bbox=1,2,3"],
    ["text", "?bbox=a,b,c,d"],
    ["south after north", "?bbox=1,10,2,5"],
    ["an object", "?bbox[$gt]=1"],
    ["repeated", "?bbox=1,2,3,4&bbox=5,6,7,8"],
  ])("a bad bbox (%s) is a 400 JSON error and never reaches the database", async (_name, query) => {
    const { find, count } = stubListings([stay(1)]);
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error.code).toBe("validation_error");
    expect(find).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  test("more matches than the cap: 200 points, capped, with the message", async () => {
    const docs = Array.from({ length: 200 }, (_, i) => stay(i));
    const { calls } = stubListings(docs, { total: 731 });
    const res = await get("?bbox=-180,-60,180,70");
    expect(calls.limit).toBe(200);
    expect(res.body.features).toHaveLength(200);
    expect(res.body.meta).toMatchObject({ total: 731, returned: 200, capped: true });
    expect(res.body.meta.message).toBe("Showing 200 of 731 stays. Zoom in to see the rest.");
  });

  test("no matches: an empty collection and a message", async () => {
    stubListings([], { total: 0 });
    const res = await get("?bbox=1,1,2,2");
    expect(res.status).toBe(200);
    expect(res.body.features).toEqual([]);
    expect(res.body.meta.message).toBe("No stays in this area.");
  });

  test("the response never contains the precise point or the address", async () => {
    stubListings([
      stay(1, {
        geometry: { type: "Point", coordinates: [73.81234, 15.50987] },
        address: { line1: "12 Secret Lane", postalCode: "403001" },
      }),
    ]);
    const res = await get("?bbox=73,15,75,16");
    for (const secret of ["73.81234", "15.50987", "Secret Lane", "403001"]) {
      expect(res.text).not.toContain(secret);
    }
  });
});
