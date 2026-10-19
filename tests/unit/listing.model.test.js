// P04-T01: Listing model v2 rules, in memory (no database).
const mongoose = require("mongoose");
const Listing = require("../../src/models/listing");
const { buildListingData } = require("../helpers/factories");

const errorsOf = async (data) => {
  try {
    await new Listing(data).validate();
    return {};
  } catch (err) {
    return err.errors || { thrown: err };
  }
};

describe("defaults", () => {
  test("a bare listing is a draft with the documented defaults", () => {
    const doc = new Listing({ title: "T" });
    expect(doc.status).toBe("draft");
    expect(doc.timezone).toBe("Asia/Kolkata");
    expect(doc.capacity.guests).toBe(2);
    expect(doc.capacity.bedrooms).toBe(1);
    expect(doc.minNights).toBe(1);
    expect(doc.maxNights).toBe(30);
    expect(doc.checkInTime).toBe("14:00");
    expect(doc.checkOutTime).toBe("11:00");
    expect(doc.instantBook).toBe(false);
    expect(doc.cancellationPolicy).toBe("moderate");
    expect(doc.pricing.currency).toBe("INR");
    expect(doc.pricing.cleaningFeeMinor).toBe(0);
    expect(doc.pricing.nightlyMinor).toBeUndefined();
    expect(doc.ratingAvg).toBe(0);
    expect(doc.ratingCount).toBe(0);
    expect(doc.needsReview).toBe(false);
    expect(doc.amenities).toHaveLength(0);
    expect(doc.images).toHaveLength(0);
    expect(doc.publicGeometry.coordinates).toBeUndefined();
  });

  test("the factory listing is valid", async () => {
    expect(await errorsOf(buildListingData())).toEqual({});
  });
});

describe("status and enums", () => {
  test.each(["draft", "published", "unpublished", "suspended"])(
    "status %s is accepted",
    async (status) => {
      expect(await errorsOf(buildListingData({ status }))).toEqual({});
    },
  );

  test("unknown status, property type, room type and policy are rejected", async () => {
    for (const bad of [
      { status: "live" },
      { propertyType: "castle-in-the-sky" },
      { roomType: "tent" },
      { cancellationPolicy: "whenever" },
    ]) {
      const errors = await errorsOf(buildListingData(bad));
      expect(Object.keys(errors)).toEqual([Object.keys(bad)[0]]);
    }
  });
});

describe("pricing", () => {
  const priced = (nightlyMinor, extra = {}) =>
    buildListingData({
      pricing: { nightlyMinor, currency: "INR", ...extra },
    });

  test("accepts the INR 100 floor and the INR 10 lakh ceiling", async () => {
    expect(await errorsOf(priced(10000))).toEqual({});
    expect(await errorsOf(priced(100000000))).toEqual({});
  });

  test("rejects below the floor, above the ceiling, fractions and negatives", async () => {
    for (const bad of [9999, 100000001, 12345.5, -1, 0]) {
      const errors = await errorsOf(priced(bad));
      expect(Object.keys(errors)).toContain("pricing.nightlyMinor");
    }
  });

  test("a listing with no price at all is valid (drafts, legacy documents)", async () => {
    expect(await errorsOf(buildListingData({ price: undefined }))).toEqual({});
  });

  test("cleaning fee may be zero but not negative or fractional; currency is a 3-letter code", async () => {
    expect(await errorsOf(priced(10000, { cleaningFeeMinor: 0 }))).toEqual({});
    for (const extra of [
      { cleaningFeeMinor: -1 },
      { cleaningFeeMinor: 1.5 },
      { currency: "inr" },
      { currency: "RUPEES" },
    ]) {
      expect(Object.keys(await errorsOf(priced(10000, extra))).length).toBe(1);
    }
  });

  test("an existing low price does not block saving other fields (validators only run on changes)", async () => {
    const doc = Listing.hydrate({
      _id: new mongoose.Types.ObjectId(),
      title: "Old",
      pricing: { nightlyMinor: 5000 },
      geometry: { type: "Point", coordinates: [1, 2] },
    });
    doc.title = "Renamed";
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

describe("nights, capacity and times", () => {
  test("minNights must not be more than maxNights", async () => {
    const errors = await errorsOf(buildListingData({ minNights: 5, maxNights: 2 }));
    expect(Object.keys(errors)).toEqual(["minNights"]);
    expect(
      await errorsOf(buildListingData({ minNights: 3, maxNights: 3 })),
    ).toEqual({});
  });

  test("nights are whole numbers from 1 to 365", async () => {
    for (const bad of [{ minNights: 0 }, { maxNights: 366 }, { minNights: 1.5 }]) {
      expect(Object.keys(await errorsOf(buildListingData(bad))).length).toBeGreaterThan(0);
    }
  });

  test("capacity.guests is at least 1 and a whole number; bathrooms allow halves", async () => {
    expect(
      Object.keys(await errorsOf(buildListingData({ capacity: { guests: 0 } }))),
    ).toContain("capacity.guests");
    expect(
      Object.keys(await errorsOf(buildListingData({ capacity: { guests: 2.5 } }))),
    ).toContain("capacity.guests");
    expect(
      Object.keys(await errorsOf(buildListingData({ capacity: { guests: 17 } }))),
    ).toContain("capacity.guests");
    expect(
      await errorsOf(buildListingData({ capacity: { guests: 4, bathrooms: 1.5 } })),
    ).toEqual({});
    expect(
      Object.keys(await errorsOf(buildListingData({ capacity: { bathrooms: 1.3 } }))),
    ).toContain("capacity.bathrooms");
  });

  test("check-in and check-out times look like HH:MM", async () => {
    expect(await errorsOf(buildListingData({ checkInTime: "09:30" }))).toEqual({});
    for (const bad of ["9:30", "24:00", "noon", "12:60"]) {
      expect(Object.keys(await errorsOf(buildListingData({ checkOutTime: bad })))).toEqual([
        "checkOutTime",
      ]);
    }
  });
});

describe("images", () => {
  const image = (n) => ({ url: `https://img/${n}.jpg`, order: n });

  test("up to 10 photos; 11 are rejected", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => image(i));
    expect(await errorsOf(buildListingData({ images: ten }))).toEqual({});
    const errors = await errorsOf(buildListingData({ images: [...ten, image(10)] }));
    expect(Object.keys(errors)).toContain("images");
  });

  test("a photo needs a url", async () => {
    const errors = await errorsOf(buildListingData({ images: [{ caption: "x" }] }));
    expect(Object.keys(errors)).toContain("images.0.url");
  });
});

describe("indexes", () => {
  test("declares the four indexes migration 003 builds, by name", () => {
    const named = Listing.schema.indexes().map(([, options]) => options.name);
    expect(named).toEqual(
      expect.arrayContaining([
        "status_1_address.city_1",
        "owner_1_status_1",
        "title_text_description_text",
        "pricing.nightlyMinor_1",
      ]),
    );
  });
});

describe("drafts and the wizard fields (P04-T02)", () => {
  const withoutPoint = () => {
    const data = buildListingData();
    delete data.geometry;
    return data;
  };

  test("a draft needs no coordinates; a published listing does", async () => {
    expect(await errorsOf({ ...withoutPoint(), status: "draft" })).toEqual({});
    const errors = await errorsOf({ ...withoutPoint(), status: "published" });
    // geometry.type is the one that cannot default; an empty coordinates array
    // passes Mongoose's own `required`, which is why the wizard also checks it.
    expect(Object.keys(errors)).toContain("geometry.type");
  });

  test("a draft still needs a title", async () => {
    expect(Object.keys(await errorsOf({ status: "draft" }))).toEqual(["title"]);
  });

  test("wizardSteps is empty until a step is saved; draftToken is optional text", () => {
    const doc = new Listing({ title: "T" });
    expect(doc.wizardSteps).toBeUndefined();
    expect(doc.draftToken).toBeUndefined();
  });

  test("declares the one-draft-per-form unique partial index", () => {
    const found = Listing.schema
      .indexes()
      .find(([, options]) => options.name === "owner_1_draftToken_1");
    expect(found[0]).toEqual({ owner: 1, draftToken: 1 });
    expect(found[1].unique).toBe(true);
    expect(found[1].partialFilterExpression).toEqual({ draftToken: { $type: "string" } });
  });
});

describe("the public (approximate) point (P06-T02)", () => {
  const { distanceMeters, MIN_OFFSET_M, MAX_OFFSET_M } = require("../../src/utils/geo");
  const PRECISE = [77.20931, 28.61391];

  test("validating a listing with a precise point sets a public point 300 to 800 m away", async () => {
    const doc = new Listing(buildListingData({ geometry: { type: "Point", coordinates: PRECISE } }));
    expect(doc.publicGeometry.coordinates).toBeUndefined();
    await doc.validate();
    expect(doc.publicGeometry.type).toBe("Point");
    const [lng, lat] = Array.from(doc.publicGeometry.coordinates);
    const d = distanceMeters({ lng: PRECISE[0], lat: PRECISE[1] }, { lng, lat });
    expect(d).toBeGreaterThanOrEqual(MIN_OFFSET_M);
    expect(d).toBeLessThanOrEqual(MAX_OFFSET_M);
    expect([lng, lat]).not.toEqual(PRECISE);
  });

  test("it is the same on every validation, and does not change when something else does", async () => {
    const doc = new Listing(buildListingData());
    await doc.validate();
    const first = Array.from(doc.publicGeometry.coordinates);
    doc.title = "A different title";
    await doc.validate();
    expect(Array.from(doc.publicGeometry.coordinates)).toEqual(first);
    expect(doc.isModified("publicGeometry")).toBe(true); // it was set once; unchanged afterwards
  });

  test("it is recomputed when the precise point moves, with the same offset direction and distance", async () => {
    const doc = new Listing(buildListingData({ geometry: { type: "Point", coordinates: PRECISE } }));
    await doc.validate();
    const before = Array.from(doc.publicGeometry.coordinates);
    doc.set("geometry.coordinates", [PRECISE[0] + 0.1, PRECISE[1]]);
    await doc.validate();
    const after = Array.from(doc.publicGeometry.coordinates);
    expect(after).not.toEqual(before);
    const d = distanceMeters({ lng: PRECISE[0] + 0.1, lat: PRECISE[1] }, { lng: after[0], lat: after[1] });
    expect(d).toBeGreaterThanOrEqual(MIN_OFFSET_M);
    expect(d).toBeLessThanOrEqual(MAX_OFFSET_M);
  });

  test("two listings at the same spot get different public points", async () => {
    const a = new Listing(buildListingData());
    const b = new Listing(buildListingData());
    await a.validate();
    await b.validate();
    expect(Array.from(a.publicGeometry.coordinates)).not.toEqual(Array.from(b.publicGeometry.coordinates));
  });

  test("a draft without a point has no public point, and losing the point removes it", async () => {
    const draft = new Listing({ title: "Draft", status: "draft" });
    await draft.validate();
    expect(draft.publicGeometry.type).toBeUndefined();

    const doc = new Listing(buildListingData());
    await doc.validate();
    expect(doc.publicGeometry.type).toBe("Point");
    doc.set("status", "draft");
    doc.set("geometry.coordinates", []);
    await doc.validate();
    expect(doc.publicGeometry.type).toBeUndefined();
  });

  test("declares the 2dsphere index on the public point only", () => {
    const geo = Listing.schema.indexes().filter(([spec]) => Object.values(spec).includes("2dsphere"));
    expect(geo).toHaveLength(1);
    expect(geo[0][0]).toEqual({ publicGeometry: "2dsphere" });
    expect(geo[0][1].name).toBe("publicGeometry_2dsphere");
  });
});
