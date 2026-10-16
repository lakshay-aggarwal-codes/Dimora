// Migration 004 against a real MongoDB: old photos (filename, no _id) become
// publicId + _id, and the model reads them.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const Listing = require("../../src/models/listing");
const { up } = require("../../scripts/migrations/004-listing-images-v2");

describeDb("migration 004 (photos)", () => {
  useTestDb();

  test("upgrades stored photos and is safe to run twice", async () => {
    const listings = mongoose.connection.db.collection("listings");
    const { insertedId } = await listings.insertOne({
      title: "Old",
      image: { url: "https://x/a.jpg", filename: "dimora_DEV/a" },
      images: [
        {
          url: "https://x/a.jpg",
          filename: "dimora_DEV/a",
          caption: "",
          order: 0,
        },
        {
          url: "https://x/b.jpg",
          filename: "dimora_DEV/b",
          caption: "",
          order: 1,
        },
      ],
    });
    const first = await up(mongoose.connection.db, {});
    expect(first.photosUpgraded).toBe(2);
    const raw = await listings.findOne({ _id: insertedId });
    expect(raw.images.map((i) => i.publicId)).toEqual([
      "dimora_DEV/a",
      "dimora_DEV/b",
    ]);
    expect(raw.images.every((i) => i._id && !("filename" in i))).toBe(true);

    const ids = raw.images.map((i) => String(i._id));
    const second = await up(mongoose.connection.db, {});
    expect(second.listingsToUpdate).toBe(0);
    const again = await listings.findOne({ _id: insertedId });
    expect(again.images.map((i) => String(i._id))).toEqual(ids); // ids are stable

    const doc = await Listing.findById(insertedId);
    expect(doc.images[0].publicId).toBe("dimora_DEV/a");
    expect(String(doc.images[1]._id)).toBe(ids[1]);
  });
});
