// P06-T04: the map service. The Mongo condition is also run against sample
// points by a tiny matcher here, so "bbox filter correctness" is checked
// without a database (the DB-backed test does it against a real one).
const { searchMap, bboxCondition, toFeature, MAP_RESULT_CAP } = require("../../src/services/mapSearch");
const { parseBbox } = require("../../src/utils/bbox");

function matches(condition, point) {
  const [lng, lat] = point;
  const range = (value, r) => value >= r.$gte && value <= r.$lte;
  if (condition.$or) return condition.$or.some((c) => matches(c, point));
  return (
    range(lng, condition["publicGeometry.coordinates.0"]) &&
    range(lat, condition["publicGeometry.coordinates.1"])
  );
}
const inBox = (bbox, point) => matches(bboxCondition(parseBbox(bbox).boxes), point);

describe("bboxCondition", () => {
  test("includes points inside and on the edge, excludes outside", () => {
    expect(inBox("73,15,75,16", [74, 15.5])).toBe(true);
    expect(inBox("73,15,75,16", [73, 15])).toBe(true);
    expect(inBox("73,15,75,16", [75.01, 15.5])).toBe(false);
    expect(inBox("73,15,75,16", [74, 16.01])).toBe(false);
    expect(inBox("73,15,75,16", [72.99, 15.5])).toBe(false);
  });

  test("a box across the antimeridian takes points on both sides, not the middle of the world", () => {
    expect(inBox("170,-20,-170,-10", [175, -15])).toBe(true);
    expect(inBox("170,-20,-170,-10", [-175, -15])).toBe(true);
    expect(inBox("170,-20,-170,-10", [0, -15])).toBe(false);
    expect(inBox("170,-20,190,-10", [-175, -15])).toBe(true);
  });

  test("a world-wide box takes every longitude but still respects latitude", () => {
    expect(inBox("-250,-60,250,70", [-179, 0])).toBe(true);
    expect(inBox("-250,-60,250,70", [179, 0])).toBe(true);
    expect(inBox("-250,-60,250,70", [10, 80])).toBe(false);
  });
});

describe("toFeature", () => {
  const base = {
    _id: "64b0000000000000000000a1",
    title: "Sea House",
    pricing: { nightlyMinor: 120000, currency: "INR" },
    publicGeometry: { type: "Point", coordinates: [73.8, 15.5] },
    geometry: { type: "Point", coordinates: [73.81234, 15.50987] },
    address: { line1: "12 Secret Lane" },
  };

  test("uses only the public point and exposes no address or precise point", () => {
    const feature = toFeature(base);
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [73.8, 15.5] });
    const text = JSON.stringify(feature);
    expect(text).not.toContain("73.81234");
    expect(text).not.toContain("15.50987");
    expect(text).not.toContain("Secret Lane");
    expect(feature.properties).toEqual({
      id: "64b0000000000000000000a1",
      title: "Sea House",
      priceMinor: 120000,
      priceLabel: "₹1,200",
      url: "/listings/64b0000000000000000000a1",
    });
    expect(feature.id).toBe("64b0000000000000000000a1");
  });

  test("a listing without a price has an empty label, not 'N/A'", () => {
    const feature = toFeature({ ...base, pricing: {} });
    expect(feature.properties.priceMinor).toBeNull();
    expect(feature.properties.priceLabel).toBe("");
  });

  test.each([
    ["no public point", { ...base, publicGeometry: undefined }],
    ["wrong type", { ...base, publicGeometry: { type: "Polygon", coordinates: [1, 2] } }],
    ["short coordinates", { ...base, publicGeometry: { type: "Point", coordinates: [1] } }],
    ["non-numeric coordinates", { ...base, publicGeometry: { type: "Point", coordinates: ["a", "b"] } }],
  ])("skips a listing with %s", (_name, listing) => {
    expect(toFeature(listing)).toBeNull();
  });
});

function fakeListing(docs, total) {
  const calls = {};
  const chain = {
    sort: (arg) => ((calls.sort = arg), chain),
    limit: (arg) => ((calls.limit = arg), chain),
    lean: () => chain,
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
  return {
    calls,
    model: {
      countDocuments: async (q) => ((calls.countQuery = q), total ?? docs.length),
      find: (q, projection) => ((calls.query = q), (calls.projection = projection), chain),
    },
  };
}

const doc = (n) => ({
  _id: `64b00000000000000000${String(n).padStart(4, "0")}`,
  title: `Stay ${n}`,
  pricing: { nightlyMinor: 100000 + n, currency: "INR" },
  publicGeometry: { type: "Point", coordinates: [73 + n / 1000, 15] },
});

describe("searchMap", () => {
  test("keeps the search filter, adds the box and the public-point condition, never asks for the precise point", async () => {
    const { model, calls } = fakeListing([doc(1)]);
    const filter = { status: "published", $and: [{ keywordsOrCategory: 1 }], "capacity.guests": { $gte: 2 } };
    const result = await searchMap(model, filter, parseBbox("73,14,74,16").boxes);
    expect(calls.query.status).toBe("published");
    expect(calls.query["capacity.guests"]).toEqual({ $gte: 2 });
    expect(calls.query["publicGeometry.type"]).toBe("Point");
    expect(calls.query.$and).toHaveLength(2); // the filter's own $and kept, box added
    expect(calls.query.$and[0]).toEqual({ keywordsOrCategory: 1 });
    expect(Object.keys(calls.projection)).not.toContain("geometry");
    expect(Object.keys(calls.projection)).not.toContain("address");
    expect(filter.$and).toHaveLength(1); // the caller's filter object is not changed
    expect(result.features).toHaveLength(1);
    expect(result.meta).toEqual({ total: 1, returned: 1, capped: false, cap: MAP_RESULT_CAP, message: "" });
  });

  test("without a box it covers every place", async () => {
    const { model, calls } = fakeListing([doc(1)]);
    await searchMap(model, { status: "published" }, null);
    expect(calls.query.$and).toBeUndefined();
  });

  test("returns at most the cap and says so", async () => {
    const docs = Array.from({ length: MAP_RESULT_CAP }, (_, i) => doc(i));
    const { model, calls } = fakeListing(docs, 450);
    const result = await searchMap(model, {}, null);
    expect(calls.limit).toBe(MAP_RESULT_CAP);
    expect(result.features).toHaveLength(MAP_RESULT_CAP);
    expect(result.meta.capped).toBe(true);
    expect(result.meta.total).toBe(450);
    expect(result.meta.message).toBe("Showing 200 of 450 stays. Zoom in to see the rest.");
  });

  test("exactly the cap is not 'capped'", async () => {
    const docs = Array.from({ length: MAP_RESULT_CAP }, (_, i) => doc(i));
    const { model } = fakeListing(docs, MAP_RESULT_CAP);
    expect((await searchMap(model, {}, null)).meta.capped).toBe(false);
  });

  test("no results: an empty collection, a message, and no listing query at all", async () => {
    const { model, calls } = fakeListing([], 0);
    const result = await searchMap(model, {}, parseBbox("1,1,2,2").boxes);
    expect(result).toEqual({
      type: "FeatureCollection",
      features: [],
      meta: { total: 0, returned: 0, capped: false, cap: MAP_RESULT_CAP, message: "No stays in this area." },
    });
    expect(calls.query).toBeUndefined();
  });

  test("a stay without a usable point is left out of the features", async () => {
    const { model } = fakeListing([doc(1), { ...doc(2), publicGeometry: undefined }], 2);
    const result = await searchMap(model, {}, null);
    expect(result.features).toHaveLength(1);
    expect(result.meta.returned).toBe(1);
  });
});
