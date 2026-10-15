// Migration 003 on a real MongoDB: old-shaped documents are written straight
// to the collection (as before v2), migrated, and then must load through the
// v2 model, validate when edited, and render on the public pages.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const Listing = require("../../src/models/listing");
const migration = require("../../scripts/migrations/003-listing-model-v2");

describeDb("listing migration 003 (database)", () => {
  useTestDb();

  const insertLegacy = async (extra = {}) => {
    const _id = new mongoose.Types.ObjectId();
    await Listing.collection.insertOne({
      _id,
      title: "Old Cottage",
      description: "From before v2",
      price: 1800,
      location: "Manali",
      country: "India",
      image: { url: "https://img.test/old.jpg", filename: "old" },
      geometry: { type: "Point", coordinates: [77.18, 32.24] },
      reviews: [],
      ...extra,
    });
    return _id;
  };

  test("converts, flags, indexes; the listing loads, edits and renders", async () => {
    const _id = await insertLegacy();
    const broken = await insertLegacy({ title: "No Price", price: undefined });
    const db = mongoose.connection.db;

    const result = await migration.up(db, {});
    expect(result.scanned).toBe(2);

    const raw = await Listing.collection.findOne({ _id });
    expect(raw.price).toBeUndefined();
    expect(raw.legacyPrice).toBe(1800);
    expect(raw.pricing.nightlyMinor).toBe(180000);
    expect(raw.status).toBe("published");

    const doc = await Listing.findById(_id);
    expect(doc.address.city).toBe("Manali");
    expect(doc.images).toHaveLength(1);
    expect(doc.needsReview).toBe(true);
    doc.title = "Renamed Cottage";
    await doc.save(); // still valid after migration

    const noPrice = await Listing.findById(broken);
    expect(noPrice.pricing.nightlyMinor).toBeUndefined();

    const agent = createAgent();
    const index = await agent.get("/listings");
    expect(index.status).toBe(200);
    expect(index.text).toContain("₹1,800");
    expect(index.text).toContain("Price not set");
    const show = await agent.get(`/listings/${_id}`);
    expect(show.status).toBe(200);
    expect(show.text).toContain("₹1,800");
    const home = await agent.get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("Manali");

    const names = (await Listing.collection.indexes()).map((i) => i.name);
    for (const name of [
      "status_1_address.city_1",
      "owner_1_status_1",
      "title_text_description_text",
      "pricing.nightlyMinor_1",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("a second run changes nothing, and down restores the old price field", async () => {
    const _id = await insertLegacy();
    const db = mongoose.connection.db;
    await migration.up(db, {});
    expect((await migration.up(db, {})).updated).toBe(0);

    await migration.down(db, {});
    const raw = await Listing.collection.findOne({ _id });
    expect(raw.price).toBe(1800);
    expect(raw.legacyPrice).toBeUndefined();
  });
});
