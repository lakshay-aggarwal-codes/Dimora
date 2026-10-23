// P12-T04 against a real MongoDB: the partial unique index (one OPEN report per
// reporter and target, also under parallel requests), the daily cap and the
// reporter's list. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/reports.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const {
  createUser,
  createListing,
  createReview,
} = require("../helpers/factories");
const Report = require("../../src/models/report");
const { createReport, listMyReports } = require("../../src/services/reports");
const { LIMITS } = require("../../src/config/reports");

describeDb("reports (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Report.init();
  });

  async function world() {
    const host = (await createUser()).user;
    const me = (await createUser()).user;
    const author = (await createUser()).user;
    const listing = await createListing({ owner: host });
    const review = await createReview({ listing, author });
    return { host, me, author, listing, review };
  }
  const send = (user, kind, id, over = {}) =>
    createReport(
      {},
      { user, kind, id: String(id), reason: "spam", details: "", ...over },
    );

  test("the partial unique index exists", async () => {
    const index = (await Report.collection.indexes()).find(
      (i) =>
        i.unique &&
        i.key.reporter === 1 &&
        i.key.targetKind === 1 &&
        i.key.targetId === 1,
    );
    expect(index).toBeDefined();
    expect(index.partialFilterExpression).toEqual({ status: "open" });
  });

  test("a report about a listing, a review and a member is stored with its owner and label", async () => {
    const w = await world();
    const a = await send(w.me, "listing", w.listing._id, {
      reason: "scam",
      details: "Looks fake",
    });
    const b = await send(w.me, "review", w.review._id);
    const c = await send(w.me, "user", w.host._id);
    expect(String(a.report.targetOwner)).toBe(String(w.host._id));
    expect(String(b.report.targetOwner)).toBe(String(w.author._id));
    expect(String(c.report.targetOwner)).toBe(String(w.host._id));
    const stored = await Report.findById(a.report._id).lean();
    expect(stored).toEqual(
      expect.objectContaining({
        status: "open",
        reason: "scam",
        details: "Looks fake",
        targetKind: "listing",
      }),
    );
    expect(stored.targetLabel).toBe(w.listing.title);
  });

  test("one open report per reporter and target, also for 8 parallel requests", async () => {
    const w = await world();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => send(w.me, "listing", w.listing._id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect(r.reason).toMatchObject({
        statusCode: 409,
        code: "already_reported",
      });
    expect(await Report.countDocuments()).toBe(1);
  });

  test("the database itself refuses a second open report, even bypassing the service", async () => {
    const w = await world();
    const doc = {
      reporter: w.me._id,
      targetKind: "listing",
      targetId: w.listing._id,
      reason: "spam",
    };
    await Report.create(doc);
    await expect(Report.create(doc)).rejects.toMatchObject({ code: 11000 });
    await Report.create({ ...doc, reporter: w.author._id }); // another person: fine
  });

  test("after it is closed the same person can report again; closed ones do not block", async () => {
    const w = await world();
    const first = await send(w.me, "listing", w.listing._id);
    await Report.updateOne({ _id: first.report._id }, { status: "dismissed" });
    await send(w.me, "listing", w.listing._id);
    expect(await Report.countDocuments({ status: "open" })).toBe(1);
    expect(await Report.countDocuments({ status: "dismissed" })).toBe(1);
  });

  test("you cannot report your own listing, review or profile", async () => {
    const w = await world();
    await expect(send(w.host, "listing", w.listing._id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(send(w.author, "review", w.review._id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(send(w.me, "user", w.me._id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await Report.countDocuments()).toBe(0);
  });

  test("an unpublished listing, and a review on it, cannot be reported (404)", async () => {
    const w = await world();
    await w.listing.constructor.updateOne(
      { _id: w.listing._id },
      { status: "unpublished" },
    );
    await expect(send(w.me, "listing", w.listing._id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(send(w.me, "review", w.review._id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test("the daily cap is counted in the database", async () => {
    const w = await world();
    const now = new Date();
    await Report.insertMany(
      Array.from({ length: LIMITS.perDay }, (_, i) => ({
        reporter: w.me._id,
        targetKind: "user",
        targetId: w.host._id,
        reason: "spam",
        status: "dismissed",
        createdAt: new Date(now.getTime() - 1000 * (i + 1)),
      })),
    );
    await expect(send(w.me, "listing", w.listing._id)).rejects.toMatchObject({
      statusCode: 429,
      code: "report_limit",
    });
    await send(w.author, "listing", w.listing._id); // other people are not affected
  });

  test("the reporter's list: newest first, own reports only", async () => {
    const w = await world();
    await send(w.me, "listing", w.listing._id);
    await send(w.me, "user", w.host._id, { reason: "offensive" });
    await send(w.author, "listing", w.listing._id);
    const mine = await listMyReports({}, w.me._id);
    expect(mine.map((r) => r.kind)).toEqual(["user", "listing"]);
    expect(
      mine.every((r) => r.status === "open" && r.statusLabel === "Received"),
    ).toBe(true);
    expect(await listMyReports({}, w.author._id)).toHaveLength(1);
  });
});
