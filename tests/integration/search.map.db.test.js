// P06-T04 against a real MongoDB: the box really selects by the PUBLIC point,
// across the antimeridian too, with the cap and the filters applied.
// Needs a MongoDB (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

const GOA = [73.8278, 15.4989];
const DELHI = [77.209, 28.6139];
const FIJI_EAST = [179.9995, -16.5]; // its public point may land on either side of 180

const get = (query) => createAgent().get(`/api/search/map${query}`);
const ids = (res) => res.body.features.map((f) => f.properties.id).sort();
const publicOf = async (listing) => [...(await Listing.findById(listing._id)).publicGeometry.coordinates];
const around = ([lng, lat], d = 0.02) => `${lng - d},${lat - d},${lng + d},${lat + d}`;

describeDb("search map data", () => {
  useTestDb();

  test("a box returns the stays whose PUBLIC point is inside it, and no others", async () => {
    const goa = await createListing({ geometry: { type: "Point", coordinates: GOA } });
    const delhi = await createListing({ geometry: { type: "Point", coordinates: DELHI } });
    const goaPoint = await publicOf(goa);

    const res = await get(`?bbox=${around(goaPoint)}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([String(goa._id)]);
    expect(res.body.features[0].geometry.coordinates).toEqual(goaPoint);
    expect(ids(await get(`?bbox=${around(await publicOf(delhi))}`))).toEqual([String(delhi._id)]);
    expect(res.body.meta.total).toBe(1);
  });

  test("a box that misses everything is empty, with the message", async () => {
    await createListing({ geometry: { type: "Point", coordinates: GOA } });
    const res = await get("?bbox=10,10,11,11");
    expect(res.body.features).toEqual([]);
    expect(res.body.meta.message).toBe("No stays in this area.");
  });

  test("a box across the antimeridian finds stays on both sides of it", async () => {
    const fiji = await createListing({ geometry: { type: "Point", coordinates: FIJI_EAST } });
    const [lng, lat] = await publicOf(fiji);
    // Mapbox reports the box either way round; both forms must find it.
    expect(ids(await get(`?bbox=170,${lat - 1},190,${lat + 1}`))).toEqual([String(fiji._id)]);
    expect(ids(await get(`?bbox=170,${lat - 1},-170,${lat + 1}`))).toEqual([String(fiji._id)]);
    expect(lng).toBeGreaterThan(-180);
    // ... and the middle of the world is not the box.
    expect(ids(await get(`?bbox=-10,${lat - 1},10,${lat + 1}`))).toEqual([]);
  });

  test("zoomed right out it covers every longitude; the filters still apply", async () => {
    const cheap = await createListing({ geometry: { type: "Point", coordinates: GOA }, price: 1000 });
    await createListing({ geometry: { type: "Point", coordinates: DELHI }, price: 9000 });
    const all = await get("?bbox=-250,-60,250,70");
    expect(all.body.meta.total).toBe(2);
    const filtered = await get("?bbox=-250,-60,250,70&maxPrice=2000");
    expect(ids(filtered)).toEqual([String(cheap._id)]);
  });

  test("unpublished and deleted stays never appear", async () => {
    await createListing({ geometry: { type: "Point", coordinates: GOA }, status: "draft" });
    await createListing({ geometry: { type: "Point", coordinates: GOA }, status: "unpublished" });
    await createListing({ geometry: { type: "Point", coordinates: GOA }, deletedAt: new Date() });
    const res = await get("?bbox=-180,-90,180,90");
    expect(res.body.features).toEqual([]);
  });

  test("the cap: 200 points come back, the total and 'capped' say there are more", async () => {
    for (let i = 0; i < 205; i += 1) {
      await createListing({ geometry: { type: "Point", coordinates: [GOA[0] + (i % 20) / 1000, GOA[1] + Math.floor(i / 20) / 1000] } });
    }
    const res = await get("?bbox=-180,-90,180,90");
    expect(res.body.features).toHaveLength(200);
    expect(res.body.meta).toMatchObject({ total: 205, returned: 200, capped: true });
    expect(res.body.meta.message).toBe("Showing 200 of 205 stays. Zoom in to see the rest.");
  }, 60000);

  test("the response has the public point only, never the precise point or the address", async () => {
    const listing = await createListing({
      geometry: { type: "Point", coordinates: [77.20931, 28.61391] },
      address: { line1: "12 Beach Road, Flat 4", city: "Delhi", country: "India", postalCode: "110001" },
    });
    const res = await get(`?bbox=${around(await publicOf(listing))}`);
    expect(res.body.features).toHaveLength(1);
    for (const leak of ["77.20931", "28.61391", "12 Beach Road", "Flat 4", "110001"]) {
      expect(res.text).not.toContain(leak);
    }
  });
});
