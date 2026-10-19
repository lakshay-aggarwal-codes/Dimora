// P06-T02 against a real MongoDB: the stored public point, the 2dsphere index,
// recomputation when the address changes, and what each kind of visitor sees.
// Needs a MongoDB (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { geocoding, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");
const migration = require("../../scripts/migrations/007-listing-public-geometry");
const { distanceMeters, MIN_OFFSET_M, MAX_OFFSET_M } = require("../../src/utils/geo");

const PRECISE = [77.20931, 28.61391];
const ADDRESS = { line1: "12 Beach Road, Flat 4", city: "Goa", state: "Goa", country: "India", postalCode: "110001" };
const LEAKS = ["77.20931", "28.61391", "12 Beach Road, Flat 4", "Flat 4", "110001"];

afterEach(resetExternalMocks);

describeDb("approximate public location", () => {
  useTestDb();

  test("saving stores a public point 300 to 800 m from the precise one, and it survives reloading", async () => {
    const listing = await createListing({ geometry: { type: "Point", coordinates: PRECISE }, address: ADDRESS });
    const stored = await Listing.findById(listing._id);
    const [lng, lat] = stored.publicGeometry.coordinates;
    const d = distanceMeters({ lng: PRECISE[0], lat: PRECISE[1] }, { lng, lat });
    expect(d).toBeGreaterThanOrEqual(MIN_OFFSET_M);
    expect(d).toBeLessThanOrEqual(MAX_OFFSET_M);
    const again = await Listing.findById(listing._id);
    expect([...again.publicGeometry.coordinates]).toEqual([lng, lat]);
  });

  test("the 2dsphere index exists and a $near query on the public point works", async () => {
    await Listing.init();
    const names = (await Listing.collection.indexes()).map((i) => i.name);
    expect(names).toContain("publicGeometry_2dsphere");
    const listing = await createListing({ geometry: { type: "Point", coordinates: PRECISE }, address: ADDRESS });
    const [lng, lat] = (await Listing.findById(listing._id)).publicGeometry.coordinates;
    const near = await Listing.find({
      publicGeometry: { $near: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: 100 } },
    });
    expect(near.map((l) => String(l._id))).toEqual([String(listing._id)]);
  });

  test("changing the address (a new precise point) moves the public point with it", async () => {
    const { user, password } = await createUser();
    const agent = await login(createAgent(), { username: user.username, password });
    const listing = await createListing({ owner: user._id, geometry: { type: "Point", coordinates: PRECISE }, address: ADDRESS });
    const before = [...(await Listing.findById(listing._id)).publicGeometry.coordinates];
    geocoding.__setFeatures([{ geometry: { type: "Point", coordinates: [73.8, 15.5] } }]);
    const changed = { ...ADDRESS, line1: "99 Far Away Road", city: "Panaji" };
    await agent.put(`/listings/${listing._id}/sections/location`).type("form").send(changed);
    await agent.put(`/listings/${listing._id}/sections/location`).type("form").send({ ...changed, confirmed: "on" });
    const stored = await Listing.findById(listing._id);
    expect([...stored.geometry.coordinates]).toEqual([73.8, 15.5]);
    const after = [...stored.publicGeometry.coordinates];
    expect(after).not.toEqual(before);
    expect(distanceMeters({ lng: 73.8, lat: 15.5 }, { lng: after[0], lat: after[1] })).toBeGreaterThanOrEqual(MIN_OFFSET_M);
  });

  test("no visitor sees the precise point or the street address in the page source: anonymous, other member, the host's own page", async () => {
    const { user: host, password: hostPassword } = await createUser();
    const listing = await createListing({ owner: host._id, geometry: { type: "Point", coordinates: PRECISE }, address: ADDRESS });
    const { user: other, password } = await createUser();
    const visitors = [
      createAgent(),
      await login(createAgent(), { username: other.username, password }),
      await login(createAgent(), { username: host.username, password: hostPassword }),
    ];
    for (const agent of visitors) {
      const res = await agent.get(`/listings/${listing._id}`);
      expect(res.status).toBe(200);
      for (const text of LEAKS) expect(res.text).not.toContain(text);
    }
  });

  test("the home page, the search results and the host's list do not contain them either", async () => {
    const { user, password } = await createUser();
    const agent = await login(createAgent(), { username: user.username, password });
    await createListing({ owner: user._id, geometry: { type: "Point", coordinates: PRECISE }, address: ADDRESS });
    for (const url of ["/", "/listings", "/listings?dest=Goa", "/host/listings"]) {
      const res = await agent.get(url);
      expect(res.status).toBe(200);
      for (const text of LEAKS) expect(res.text).not.toContain(text);
    }
  });

  describe("migration 007", () => {
    test("fills the public point for listings that have none and builds the index", async () => {
      process.env.SESSION_SECRET = process.env.SESSION_SECRET || "a-test-session-secret-of-32-characters-min";
      const _id = new mongoose.Types.ObjectId();
      await Listing.collection.insertOne({
        _id,
        title: "Old listing",
        status: "published",
        geometry: { type: "Point", coordinates: PRECISE },
      });
      const db = mongoose.connection.db;
      expect((await migration.up(db, {})).updated).toBeGreaterThanOrEqual(1);
      const raw = await Listing.collection.findOne({ _id });
      expect(raw.publicGeometry.type).toBe("Point");
      expect(raw.publicGeometry.coordinates).not.toEqual(PRECISE);
      expect((await migration.up(db, {})).updated).toBe(0);
      expect((await Listing.collection.indexes()).map((i) => i.name)).toContain("publicGeometry_2dsphere");
    });
  });
});
