// Migration 003 (listing model v2) without a database: a small in-memory fake
// covers find/bulkWrite/createIndex. The real-MongoDB run is in
// tests/integration/listing.migration.db.test.js.
const { readOnlyDb } = require("../../scripts/migrate");
const {
  up,
  down,
  planListingMigration,
  legacyPriceToMinor,
} = require("../../scripts/migrations/003-listing-model-v2");

const oid = (n) => ({
  toString: () => `id${n}`,
  getTimestamp: () => new Date("2024-03-01T00:00:00.000Z"),
});

function setDotted(doc, path, value) {
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === undefined) target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

class FakeCollection {
  constructor(docs) {
    this.docs = docs;
    this.writes = 0;
    this.indexes = [];
  }
  find(filter = {}) {
    const ids = filter._id && filter._id.$in;
    const rows = ids
      ? this.docs.filter((d) => ids.includes(String(d._id)))
      : this.docs;
    // Shallow copies keep the _id objects (and Dates) as they are.
    return { toArray: async () => rows.map((d) => ({ ...d })) };
  }
  async bulkWrite(operations) {
    let modifiedCount = 0;
    for (const { updateOne } of operations) {
      const doc = this.docs.find((d) => d._id === updateOne.filter._id);
      if (!doc) continue;
      for (const [k, v] of Object.entries(updateOne.update.$set || {})) {
        setDotted(doc, k, v);
      }
      for (const k of Object.keys(updateOne.update.$unset || {})) delete doc[k];
      modifiedCount += 1;
      this.writes += 1;
    }
    return { modifiedCount };
  }
  async createIndex(spec, options) {
    this.writes += 1;
    this.indexes.push({ spec, options });
  }
}

function fakeDb(listings, reviews = []) {
  const collections = {
    listings: new FakeCollection(listings),
    reviews: new FakeCollection(reviews),
  };
  return { collections, collection: (name) => collections[name] };
}

const legacy = (n, extra = {}) => ({
  _id: oid(n),
  title: `Listing ${n}`,
  description: "d",
  price: 1200,
  location: "Goa",
  country: "India",
  image: { url: `https://img/${n}.jpg`, filename: `f${n}` },
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
  reviews: [],
  ...extra,
});

describe("legacyPriceToMinor", () => {
  test("rupees to paise, tolerating numeric strings; junk is null", () => {
    expect(legacyPriceToMinor(1200)).toBe(120000);
    expect(legacyPriceToMinor("1200")).toBe(120000);
    expect(legacyPriceToMinor(99.99)).toBe(9999);
    expect(legacyPriceToMinor(0)).toBe(0);
    for (const bad of [undefined, null, "", "abc", -1, NaN, Infinity, 1e300]) {
      expect(legacyPriceToMinor(bad)).toBeNull();
    }
  });
});

describe("planListingMigration", () => {
  test("a normal old listing gets pricing, status, address, images and defaults", () => {
    const { updates, counts } = planListingMigration([legacy(1)]);
    const { set, unset } = updates[0];
    expect(set.status).toBe("published");
    expect(set["pricing.nightlyMinor"]).toBe(120000);
    expect(set["pricing.currency"]).toBe("INR");
    expect(set.legacyPrice).toBe(1200);
    expect(unset).toEqual({ price: "" });
    expect(set["address.city"]).toBe("Goa");
    expect(set["address.country"]).toBe("India");
    expect(set.images).toEqual([
      { url: "https://img/1.jpg", filename: "f1", caption: "", order: 0 },
    ]);
    expect(set.timezone).toBe("Asia/Kolkata");
    expect(set["capacity.guests"]).toBe(2);
    expect(set.minNights).toBe(1);
    expect(set.maxNights).toBe(30);
    expect(set.createdAt).toEqual(new Date("2024-03-01T00:00:00.000Z"));
    expect(set.updatedAt).toEqual(set.createdAt);
    // The address is a guess, so the listing is flagged for the host.
    expect(set.needsReview).toBe(true);
    expect(counts).toMatchObject({ priceConverted: 1, addressDerived: 1, imagesSeeded: 1 });
  });

  test("broken documents: no price, junk price, no image, no geometry, nothing at all", () => {
    const docs = [
      legacy(1, { price: undefined }),
      legacy(2, { price: "abc" }),
      legacy(3, { image: undefined }),
      legacy(4, { geometry: undefined }),
      { _id: oid(5) },
    ];
    const { updates, counts } = planListingMigration(docs);
    expect(updates).toHaveLength(5);
    for (const u of updates.slice(0, 2)) {
      expect(u.set["pricing.nightlyMinor"]).toBeUndefined();
      expect(u.set.needsReview).toBe(true);
    }
    expect(updates[1].set.legacyPrice).toBe("abc"); // the original is kept as found
    expect(updates[2].set.images).toBeUndefined();
    expect(updates[3].set.needsReview).toBe(true);
    expect(updates[4].set["address.city"]).toBeUndefined();
    expect(updates[4].set.status).toBe("published");
    expect(counts.withoutPrice).toBe(3); // undefined, "abc" and the empty doc
    expect(counts.withoutGeometry).toBe(2);
  });

  test("a price under the INR 100 floor is converted as it is and flagged", () => {
    const { updates, counts } = planListingMigration([legacy(1, { price: 50 })]);
    expect(updates[0].set["pricing.nightlyMinor"]).toBe(5000);
    expect(updates[0].set.needsReview).toBe(true);
    expect(counts.belowFloor).toBe(1);
  });

  test("rating aggregates come from the reviews the listing already has", () => {
    const ratings = new Map([
      ["r1", 5],
      ["r2", 4],
      ["r3", 4],
    ]);
    const { updates } = planListingMigration(
      [legacy(1, { reviews: ["r1", "r2", "r3", "gone"] }), legacy(2)],
      ratings,
    );
    expect(updates[0].set.ratingCount).toBe(3);
    expect(updates[0].set.ratingAvg).toBe(4.33);
    expect(updates[1].set.ratingCount).toBe(0);
    expect(updates[1].set.ratingAvg).toBe(0);
  });

  test("an already migrated listing produces no update, and needsReview is never switched off", () => {
    const migrated = legacy(1);
    const { updates } = planListingMigration([migrated]);
    const done = JSON.parse(JSON.stringify(migrated));
    delete done.price;
    for (const [k, v] of Object.entries(updates[0].set)) setDotted(done, k, v);
    expect(planListingMigration([done]).updates).toHaveLength(0);

    done.needsReview = true;
    done.address = { city: "Goa", country: "India" };
    expect(planListingMigration([done]).updates).toHaveLength(0);
  });

  test("existing v2 values are never overwritten", () => {
    const { updates } = planListingMigration([
      legacy(1, {
        status: "draft",
        pricing: { nightlyMinor: 77700, cleaningFeeMinor: 5000, currency: "INR" },
        address: { city: "Panaji", country: "India" },
        images: [{ url: "https://img/own.jpg" }],
        timezone: "UTC",
        capacity: { guests: 6 },
        minNights: 2,
      }),
    ]);
    const set = updates[0].set;
    for (const key of [
      "status",
      "pricing.nightlyMinor",
      "pricing.cleaningFeeMinor",
      "address.city",
      "images",
      "timezone",
      "capacity.guests",
      "minNights",
    ]) {
      expect(set[key]).toBeUndefined();
    }
    expect(set["capacity.beds"]).toBe(1);
  });
});

describe("up", () => {
  test("a dry run counts and writes nothing", async () => {
    const db = fakeDb([legacy(1), legacy(2, { price: undefined })]);
    const result = await up(readOnlyDb(db), { dryRun: true });
    expect(result).toMatchObject({ scanned: 2, toUpdate: 2, priceConverted: 1, indexes: 4 });
    expect(db.collections.listings.writes).toBe(0);
  });

  test("applies the plan, builds the four indexes, and a second run changes nothing", async () => {
    const docs = [legacy(1), legacy(2, { price: undefined }), { _id: oid(3) }];
    const db = fakeDb(docs, [{ _id: "r1", rating: 5 }]);
    docs[0].reviews = ["r1"];

    const first = await up(db, {});
    expect(first).toMatchObject({ scanned: 3, updated: 3, priceConverted: 1, indexes: 4 });
    expect(docs[0].price).toBeUndefined();
    expect(docs[0].legacyPrice).toBe(1200);
    expect(docs[0].pricing.nightlyMinor).toBe(120000);
    expect(docs[0].status).toBe("published");
    expect(docs[0].ratingAvg).toBe(5);
    expect(db.collections.listings.indexes.map((i) => i.options.name)).toEqual([
      "status_1_address.city_1",
      "owner_1_status_1",
      "title_text_description_text",
      "pricing.nightlyMinor_1",
    ]);

    const second = await up(db, {});
    expect(second.updated).toBe(0);
  });

  test("an empty collection is fine", async () => {
    const db = fakeDb([]);
    expect(await up(db, {})).toMatchObject({ scanned: 0, updated: 0 });
  });
});

test("down exists (manual rollback) and a dry run only counts", async () => {
  expect(typeof down).toBe("function");
  const calls = [];
  const db = {
    collection: () => ({
      countDocuments: async () => 3,
      updateMany: async () => calls.push("write"),
    }),
  };
  expect(await down(db, { dryRun: true })).toEqual({ wouldRestorePrice: 3 });
  expect(calls).toEqual([]);
});
