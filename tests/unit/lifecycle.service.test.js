// P04-T05: publish / unpublish / soft delete (no database; the listing is a
// small stand-in with save(), the ledger is a fake).
const {
  NotReadyError,
  publishListing,
  unpublishListing,
  softDeleteListing,
} = require("../../src/services/lifecycle");
const { ValidationError, ConflictError } = require("../../src/utils/errors");
const { isPublic, publicListingFilter } = require("../../src/utils/visibility");

const photo = (n) => ({ url: `https://res.cloudinary.test/p${n}.jpg` });
function listing(overrides = {}) {
  return {
    _id: "64b0f0f0f0f0f0f0f0f0aaaa",
    status: "draft",
    images: [1, 2, 3, 4, 5].map(photo),
    description: "x".repeat(200),
    address: { line1: "12 Beach Road", city: "Goa", country: "India" },
    geometry: { type: "Point", coordinates: [73.8, 15.5] },
    needsReview: false,
    capacity: { guests: 4, beds: 3 },
    pricing: { nightlyMinor: 250000 },
    houseRules: "No smoking.",
    checkInTime: "14:00",
    checkOutTime: "11:00",
    cancellationPolicy: "moderate",
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("publishListing", () => {
  test("a ready draft becomes published and is saved once", async () => {
    const l = listing();
    const result = await publishListing(l);
    expect(result.changed).toBe(true);
    expect(l.status).toBe("published");
    expect(l.save).toHaveBeenCalledTimes(1);
  });

  test("an unpublished listing can be published again", async () => {
    const l = listing({ status: "unpublished" });
    await publishListing(l);
    expect(l.status).toBe("published");
  });

  test("an incomplete listing is refused with the list of what is missing; nothing is saved", async () => {
    const l = listing({ images: [photo(1)], houseRules: "" });
    const error = await publishListing(l).catch((e) => e);
    expect(error).toBeInstanceOf(NotReadyError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.failed.map((c) => c.key)).toEqual(["photos", "rules"]);
    expect(error.message).toMatch(/At least 5 photos/);
    expect(error.message).toMatch(/no special rules/);
    expect(l.status).toBe("draft");
    expect(l.save).not.toHaveBeenCalled();
  });

  test.each([
    ["photos", { images: [1, 2, 3, 4].map(photo) }],
    ["description", { description: "short" }],
    ["address", { geometry: undefined }],
    ["capacity", { capacity: { guests: 0, beds: 1 } }],
    ["price", { pricing: {} }],
    ["rules", { houseRules: "" }],
    ["times", { checkInTime: "" }],
    ["cancellation", { cancellationPolicy: undefined }],
  ])("any single failing item (%s) blocks publishing", async (key, patch) => {
    const l = listing(patch);
    const error = await publishListing(l).catch((e) => e);
    expect(error).toBeInstanceOf(NotReadyError);
    expect(error.failed.map((c) => c.key)).toEqual([key]);
    expect(l.status).toBe("draft");
  });

  test("the checklist and the publish action agree", async () => {
    const { evaluateReadiness } = require("../../src/services/readiness");
    for (const patch of [
      {},
      { images: [] },
      { description: "" },
      { cancellationPolicy: "x" },
    ]) {
      const l = listing(patch);
      const ready = evaluateReadiness(l).canPublish;
      const outcome = await publishListing(l).then(
        () => true,
        () => false,
      );
      expect(outcome).toBe(ready);
    }
  });

  test("an already published listing is left alone (no save)", async () => {
    const l = listing({ status: "published" });
    expect((await publishListing(l)).changed).toBe(false);
    expect(l.save).not.toHaveBeenCalled();
  });

  test("a deleted listing cannot be published", async () => {
    const l = listing({ deletedAt: new Date() });
    await expect(publishListing(l)).rejects.toThrow(/deleted/);
    expect(l.save).not.toHaveBeenCalled();
  });

  test("a status that is not draft/unpublished/published is refused", async () => {
    await expect(
      publishListing(listing({ status: "suspended" })),
    ).rejects.toThrow(/cannot be published/);
  });

  test("the photo minimum can be changed by the caller", async () => {
    const l = listing({ images: [photo(1), photo(2)] });
    await publishListing(l, { readiness: { minPhotos: 2 } });
    expect(l.status).toBe("published");
  });
});

describe("unpublishListing", () => {
  test("published -> unpublished, saved", async () => {
    const l = listing({ status: "published" });
    expect((await unpublishListing(l)).changed).toBe(true);
    expect(l.status).toBe("unpublished");
    expect(l.save).toHaveBeenCalledTimes(1);
  });
  test("already unpublished: no change, no save", async () => {
    const l = listing({ status: "unpublished" });
    expect((await unpublishListing(l)).changed).toBe(false);
    expect(l.save).not.toHaveBeenCalled();
  });
  test("a draft cannot be unpublished", async () => {
    await expect(unpublishListing(listing())).rejects.toThrow(ValidationError);
  });
  test("a deleted listing cannot", async () => {
    await expect(
      unpublishListing(listing({ status: "published", deletedAt: new Date() })),
    ).rejects.toThrow(/deleted/);
  });
});

describe("softDeleteListing", () => {
  const ledger = (upcoming) => ({
    hasUpcomingReservation: jest.fn().mockResolvedValue(upcoming),
  });
  const now = new Date("2026-10-17T10:00:00Z");

  test("marks the listing deleted and hides it (status unpublished)", async () => {
    const l = listing({ status: "published", timezone: "Asia/Kolkata" });
    const fake = ledger(false);
    const result = await softDeleteListing(l, { now, ledgerService: fake });
    expect(result.changed).toBe(true);
    expect(l.deletedAt).toBe(now);
    expect(l.status).toBe("unpublished");
    expect(l.save).toHaveBeenCalledTimes(1);
    expect(fake.hasUpcomingReservation).toHaveBeenCalledWith(l._id, {
      now,
      timeZone: "Asia/Kolkata",
    });
  });

  test("a draft can be deleted and stays a draft record", async () => {
    const l = listing();
    await softDeleteListing(l, { now, ledgerService: ledger(false) });
    expect(l.deletedAt).toBe(now);
    expect(l.status).toBe("draft");
  });

  test("refused while a reservation is upcoming: nothing is saved", async () => {
    const l = listing({ status: "published" });
    const error = await softDeleteListing(l, {
      now,
      ledgerService: ledger(true),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/upcoming reservations/);
    expect(l.deletedAt).toBeUndefined();
    expect(l.status).toBe("published");
    expect(l.save).not.toHaveBeenCalled();
  });

  test("deleting twice is harmless", async () => {
    const l = listing({ status: "published" });
    const fake = ledger(false);
    await softDeleteListing(l, { now, ledgerService: fake });
    l.save.mockClear();
    expect(
      (await softDeleteListing(l, { now, ledgerService: fake })).changed,
    ).toBe(false);
    expect(l.save).not.toHaveBeenCalled();
    expect(fake.hasUpcomingReservation).toHaveBeenCalledTimes(1);
  });
});

describe("visibility", () => {
  test("only published and not deleted is public", () => {
    expect(isPublic({ status: "published" })).toBe(true);
    expect(isPublic({ status: "published", deletedAt: null })).toBe(true);
    expect(isPublic({ status: "published", deletedAt: new Date() })).toBe(
      false,
    );
    for (const status of ["draft", "unpublished", "suspended", undefined]) {
      expect(isPublic({ status })).toBe(false);
    }
    expect(isPublic(null)).toBe(false);
    expect(isPublic(undefined)).toBe(false);
  });
  test("the query filter asks for the same thing", () => {
    expect(publicListingFilter()).toEqual({
      status: "published",
      deletedAt: null,
    });
  });
});
