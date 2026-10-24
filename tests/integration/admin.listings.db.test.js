// P14-T03 against a real MongoDB: the conditional updates, parallel admins,
// the queues. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/admin.listings.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Report = require("../../src/models/report");
const m = require("../../src/services/listingModeration");
const { isPublic } = require("../../src/utils/visibility");

describeDb("listing moderation (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Report.init();
  });

  async function world() {
    const admin = (await createUser()).user;
    const host = (await createUser()).user;
    const listing = await createListing({ owner: host });
    return { admin, host, listing };
  }
  const load = (id) => Listing.findById(id).lean();

  test("suspend hides it from the public, keeps the reason for the host, and counts as reviewed", async () => {
    const w = await world();
    await m.suspendListing({
      admin: w.admin,
      id: String(w.listing._id),
      reason: "Photos are of another place",
    });
    const stored = await load(w.listing._id);
    expect(stored.status).toBe("suspended");
    expect(isPublic(stored)).toBe(false);
    expect(stored.moderation.suspendReason).toBe("Photos are of another place");
    expect(String(stored.moderation.suspendedBy)).toBe(String(w.admin._id));
    expect(stored.moderation.suspendedAt).toBeInstanceOf(Date);
    expect(stored.moderation.reviewedAt).toBeInstanceOf(Date);
    expect(stored.hiddenByOwnerSuspension).toBeUndefined();
  });

  test("restore publishes it again and clears the suspension record", async () => {
    const w = await world();
    await m.suspendListing({
      admin: w.admin,
      id: String(w.listing._id),
      reason: "Fake photos here",
    });
    await m.restoreListing({
      admin: w.admin,
      id: String(w.listing._id),
      reason: "Host replaced the photos",
    });
    const stored = await load(w.listing._id);
    expect(stored.status).toBe("published");
    expect(isPublic(stored)).toBe(true);
    expect(stored.moderation.suspendReason).toBeUndefined();
    expect(stored.moderation.suspendedAt).toBeUndefined();
    expect(stored.moderation.reviewedAt).toBeInstanceOf(Date);
  });

  test("8 admins suspending at once: exactly one succeeds", async () => {
    const w = await world();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        m.suspendListing({
          admin: w.admin,
          id: String(w.listing._id),
          reason: "Spam listing, repeated",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect(r.reason).toBeInstanceOf(m.ModerationError);
    expect((await load(w.listing._id)).status).toBe("suspended");
  });

  test("a listing hidden with its host's account is not restorable here and stays hidden", async () => {
    const w = await world();
    await Listing.updateOne(
      { _id: w.listing._id },
      { status: "suspended", hiddenByOwnerSuspension: true },
    );
    await expect(
      m.restoreListing({
        admin: w.admin,
        id: String(w.listing._id),
        reason: "Looks fine to me",
      }),
    ).rejects.toThrow(/host's account is suspended/);
    expect((await load(w.listing._id)).status).toBe("suspended");
  });

  test("only a published listing can be suspended; a draft, an unpublished and a deleted one are refused", async () => {
    const w = await world();
    const draft = await createListing({ owner: w.host, status: "draft" });
    const off = await createListing({ owner: w.host, status: "unpublished" });
    const gone = await createListing({ owner: w.host, deletedAt: new Date() });
    for (const l of [draft, off, gone]) {
      await expect(
        m.suspendListing({
          admin: w.admin,
          id: String(l._id),
          reason: "A good enough reason",
        }),
      ).rejects.toBeInstanceOf(m.ModerationError);
    }
    expect((await load(draft._id)).status).toBe("draft");
  });

  test("mark reviewed removes it from the new queue, once", async () => {
    const w = await world();
    let queue = await m.listQueue({ filter: "new" });
    expect(queue.rows.map((r) => r.id)).toContain(String(w.listing._id));
    await m.markReviewed({
      admin: w.admin,
      id: String(w.listing._id),
      note: "Checked",
    });
    queue = await m.listQueue({ filter: "new" });
    expect(queue.rows.map((r) => r.id)).not.toContain(String(w.listing._id));
    await expect(
      m.markReviewed({ admin: w.admin, id: String(w.listing._id) }),
    ).rejects.toThrow(/already marked/);
  });

  test("the queues: reported (most reports first), new, suspended", async () => {
    const w = await world();
    const second = await createListing({
      owner: w.host,
      title: "Second house",
    });
    const r1 = (await createUser()).user;
    const r2 = (await createUser()).user;
    await Report.create({
      reporter: r1._id,
      targetKind: "listing",
      targetId: second._id,
      reason: "scam",
    });
    await Report.create({
      reporter: r2._id,
      targetKind: "listing",
      targetId: second._id,
      reason: "spam",
    });
    await Report.create({
      reporter: r1._id,
      targetKind: "listing",
      targetId: w.listing._id,
      reason: "spam",
    });
    await Report.create({
      reporter: r2._id,
      targetKind: "listing",
      targetId: w.listing._id,
      reason: "spam",
      status: "dismissed",
    });

    const reported = await m.listQueue({ filter: "reported" });
    expect(reported.rows.map((r) => [r.id, r.openReports])).toEqual([
      [String(second._id), 2],
      [String(w.listing._id), 1],
    ]);

    await m.suspendListing({
      admin: w.admin,
      id: String(second._id),
      reason: "Reported twice, fake",
    });
    const suspended = await m.listQueue({ filter: "suspended" });
    expect(suspended.rows.map((r) => r.id)).toEqual([String(second._id)]);
    expect(suspended.rows[0].openReports).toBe(2);
    expect(
      (await m.listQueue({ filter: "new" })).rows.map((r) => r.id),
    ).toEqual([String(w.listing._id)]);
  });

  test("the moderation page shows the open reports and no email address", async () => {
    const w = await world();
    const reporter = (await createUser()).user;
    await Report.create({
      reporter: reporter._id,
      targetKind: "listing",
      targetId: w.listing._id,
      reason: "scam",
      details: "Looks fake",
    });
    const page = await m.getListingForModeration(String(w.listing._id));
    expect(page.reports).toEqual([
      expect.objectContaining({
        reporter: reporter.username,
        reason: "Scam or fraud",
        details: "Looks fake",
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain(w.host.email);
  });
});
