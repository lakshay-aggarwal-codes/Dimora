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
