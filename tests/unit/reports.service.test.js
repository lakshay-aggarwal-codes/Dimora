// P12-T04: sending and listing reports over in-memory fakes. Real MongoDB (the
// partial unique index, parallel requests): tests/integration/reports.db.test.js.
const mongoose = require("mongoose");
const {
  createReport,
  describeTarget,
  listMyReports,
  parseReportInput,
} = require("../../src/services/reports");
const { LIMITS, REASON_VALUES } = require("../../src/config/reports");
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../../src/utils/errors");

const oid = () => new mongoose.Types.ObjectId();
const T0 = new Date("2026-11-20T06:00:00.000Z");
const DAY = 24 * 3600000;

const asChain = (value) => {
  const c = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    lean: () => c,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return c;
};

function setup() {
  const me = { _id: oid(), username: "me", role: "member", status: "active" };
  const host = {
    _id: oid(),
    username: "asha",
    displayName: "Asha K",
    status: "active",
  };
  const author = { _id: oid(), username: "ravi", status: "active" };
  const listing = {
    _id: oid(),
    title: "Sea  house",
    owner: host._id,
    status: "published",
    deletedAt: null,
    reviews: [],
  };
  const review = { _id: oid(), author: author._id };
  listing.reviews = [review._id];

  const reports = [];
  const ListingModel = {
    findById: (id) =>
      asChain(String(listing._id) === String(id) ? listing : null),
    findOne: (filter) =>
      asChain(
        filter.reviews && String(filter.reviews) === String(review._id)
          ? listing
          : null,
      ),
  };
  const ReviewModel = {
    findById: (id) =>
      asChain(String(review._id) === String(id) ? review : null),
  };
  const users = [me, host, author];
  const UserModel = {
    findOne: (filter) =>
      asChain(
        users.find(
          (u) =>
            String(u._id) === String(filter._id) && u.status === filter.status,
        ) || null,
      ),
  };
  const ReportModel = {
    reports,
    countDocuments: async (filter) =>
      reports.filter(
        (r) =>
          String(r.reporter) === String(filter.reporter) &&
          r.createdAt >= filter.createdAt.$gte,
      ).length,
    exists: async (filter) =>
      reports.some(
        (r) =>
          String(r.reporter) === String(filter.reporter) &&
          r.targetKind === filter.targetKind &&
          String(r.targetId) === String(filter.targetId) &&
          r.status === "open",
      )
        ? { _id: 1 }
        : null,
    create: async (doc) => {
      // the partial unique index: one OPEN report per (reporter, target)
      if (
        reports.some(
          (r) =>
            String(r.reporter) === String(doc.reporter) &&
            r.targetKind === doc.targetKind &&
            String(r.targetId) === String(doc.targetId) &&
            r.status === "open",
        )
      ) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      }
      const row = {
        _id: oid(),
        status: "open",
        createdAt: ReportModel.clock(),
        ...doc,
      };
      reports.push(row);
      return row;
    },
    find: (filter) =>
      asChain(
        reports
          .filter((r) => String(r.reporter) === String(filter.reporter))
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    clock: () => T0,
  };
  const deps = { ReportModel, ListingModel, ReviewModel, UserModel };
  const send = (kind, id, over = {}, user = me) =>
    createReport(deps, {
      user,
      kind,
      id: String(id),
      reason: "spam",
      details: "",
      now: T0,
      ...over,
    });
  return {
    me,
    host,
    author,
    listing,
    review,
    reports,
    ReportModel,
    deps,
    send,
  };
}

describe("parseReportInput", () => {
  test("a reason from the list; details trimmed; empty details allowed", () => {
    expect(
      parseReportInput({ reason: "spam", details: "  buy now  " }),
    ).toEqual({ reason: "spam", details: "buy now" });
    expect(parseReportInput({ reason: "scam" })).toEqual({
      reason: "scam",
      details: "",
    });
    expect(parseReportInput({ reason: "scam", details: null }).details).toBe(
      "",
    );
  });
  test.each([
    undefined,
    "",
    "SPAM",
    "nonsense",
    ["spam"],
    { $ne: "" },
    5,
    null,
    "__proto__",
  ])("reason %p is refused", (reason) => {
    expect(() => parseReportInput({ reason })).toThrow(ValidationError);
  });
  test("details: text only, at most 1000 characters, refused (never cut) beyond that", () => {
    expect(
      parseReportInput({
        reason: "spam",
        details: "x".repeat(LIMITS.detailsMax),
      }).details,
    ).toHaveLength(LIMITS.detailsMax);
    expect(() =>
      parseReportInput({
        reason: "spam",
        details: "x".repeat(LIMITS.detailsMax + 1),
      }),
    ).toThrow(/at most 1000/);
    for (const bad of [5, ["a"], { a: 1 }, true])
      expect(() => parseReportInput({ reason: "spam", details: bad })).toThrow(
        /must be text/,
      );
  });
  test('"something else" needs a few words; spaces do not count', () => {
    expect(() => parseReportInput({ reason: "other" })).toThrow(
      /a little more/,
    );
    expect(() =>
      parseReportInput({ reason: "other", details: "          " }),
    ).toThrow(/a little more/);
    expect(() =>
      parseReportInput({ reason: "other", details: "too short" }),
    ).toThrow(/a little more/);
    expect(
      parseReportInput({ reason: "other", details: "This is clearly wrong." })
        .reason,
    ).toBe("other");
  });
  test("every reason in the list is accepted", () => {
    for (const reason of REASON_VALUES.filter((r) => r !== "other"))
      expect(parseReportInput({ reason }).reason).toBe(reason);
  });
});

describe("describeTarget", () => {
  test("a published listing, a review on one, an active member", async () => {
    const c = setup();
    expect(
      await describeTarget(c.deps, "listing", String(c.listing._id)),
    ).toEqual({
      kind: "listing",
      id: String(c.listing._id),
      owner: c.host._id,
      label: "Sea house",
      url: `/listings/${c.listing._id}`,
    });
    const review = await describeTarget(c.deps, "review", String(c.review._id));
    expect(review).toEqual(
      expect.objectContaining({
        owner: c.author._id,
        label: "A review of Sea house",
        url: `/listings/${c.listing._id}#reviews-heading`,
      }),
    );
    expect(await describeTarget(c.deps, "user", String(c.host._id))).toEqual(
      expect.objectContaining({
        owner: c.host._id,
        label: "Asha K",
        url: `/users/${c.host._id}`,
      }),
    );
  });

  test("anything that cannot be seen is the same 404: unpublished, deleted, missing, malformed", async () => {
    const c = setup();
    for (const patch of [
      { status: "draft" },
      { status: "unpublished" },
      { status: "suspended" },
      { deletedAt: T0 },
    ]) {
      Object.assign(c.listing, patch);
      await expect(
        describeTarget(c.deps, "listing", String(c.listing._id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        describeTarget(c.deps, "review", String(c.review._id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      Object.assign(c.listing, { status: "published", deletedAt: null });
    }
    await expect(
      describeTarget(c.deps, "listing", String(oid())),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      describeTarget(c.deps, "review", String(oid())),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      describeTarget(c.deps, "user", String(oid())),
    ).rejects.toBeInstanceOf(NotFoundError);
    c.host.status = "suspended";
    await expect(
      describeTarget(c.deps, "user", String(c.host._id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    for (const id of [
      "not-an-id",
      "",
      undefined,
      "a".repeat(23),
      { $gt: "" },
      ["x"],
    ]) {
      await expect(
        describeTarget(c.deps, "listing", id),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  test("an unknown kind or none is a 400; messages cannot be reported yet", async () => {
    const c = setup();
    for (const kind of ["", "booking", undefined, "__proto__", ["listing"]]) {
      await expect(
        describeTarget(c.deps, kind, String(c.listing._id)),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      describeTarget(c.deps, "message", String(oid())),
    ).rejects.toThrow(/Messages cannot be reported yet/);
  });

  test("a review with no author is reportable; its owner is null", async () => {
    const c = setup();
    c.review.author = undefined;
    expect(
      (await describeTarget(c.deps, "review", String(c.review._id))).owner,
    ).toBeNull();
  });
});

describe("createReport", () => {
  test("stores who, what, why, the owner and a label; the reporter sees it as open", async () => {
    const c = setup();
    const { report, created } = await c.send("listing", c.listing._id, {
      reason: "inaccurate",
      details: "  The photos are of another place.  ",
    });
    expect(created).toBe(true);
    expect(report).toEqual(
      expect.objectContaining({
        reporter: c.me._id,
        targetKind: "listing",
        targetId: String(c.listing._id),
        targetOwner: c.host._id,
        targetLabel: "Sea house",
        reason: "inaccurate",
        details: "The photos are of another place.",
        status: "open",
      }),
    );
    expect(c.reports).toHaveLength(1);
  });

  test("no details: the field is left out, not stored empty", async () => {
    const c = setup();
    const { report } = await c.send("user", c.host._id, { details: "" });
    expect("details" in report && report.details !== undefined).toBe(false);
  });

  test("you cannot report your own listing, review or profile (403), and nothing is stored", async () => {
    const c = setup();
    await expect(c.send("listing", c.listing._id, {}, c.host)).rejects.toThrow(
      /cannot report your own listing/,
    );
    await expect(c.send("review", c.review._id, {}, c.author)).rejects.toThrow(
      /cannot report your own review/,
    );
    await expect(c.send("user", c.me._id, {})).rejects.toThrow(
      /cannot report your own member/,
    );
    await expect(
      c.send("listing", c.listing._id, {}, c.host),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(c.reports).toHaveLength(0);
  });

  test("a suspended account, or nobody, cannot report", async () => {
    const c = setup();
    await expect(
      c.send("listing", c.listing._id, {}, { ...c.me, status: "suspended" }),
    ).rejects.toThrow(/Your account cannot send reports/);
    await expect(
      c.send("listing", c.listing._id, {}, null),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(c.reports).toHaveLength(0);
  });

  test("one open report per person and target: the second is a 409 that says so", async () => {
    const c = setup();
    await c.send("listing", c.listing._id);
    const again = c.send("listing", c.listing._id, { reason: "scam" });
    await expect(again).rejects.toBeInstanceOf(ConflictError);
    await expect(again).rejects.toMatchObject({
      code: "already_reported",
      statusCode: 409,
    });
    expect(c.reports).toHaveLength(1);
  });

  test("two clicks at once make one report (the index decides, the loser gets the same 409)", async () => {
    const c = setup();
    // make the friendly pre-check blind, as it is when both requests pass it before either writes
    c.ReportModel.exists = async () => null;
    const results = await Promise.allSettled([
      c.send("listing", c.listing._id),
      c.send("listing", c.listing._id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({
      code: "already_reported",
    });
    expect(c.reports).toHaveLength(1);
  });

  test("other people may report the same thing, and one person may report different things", async () => {
    const c = setup();
    await c.send("listing", c.listing._id);
    await c.send("listing", c.listing._id, {}, c.author);
    await c.send("review", c.review._id);
    await c.send("user", c.host._id);
    expect(c.reports).toHaveLength(4);
  });

  test("after a report is closed the same person may report the same thing again", async () => {
    const c = setup();
    await c.send("listing", c.listing._id);
    c.reports[0].status = "dismissed";
    await c.send("listing", c.listing._id);
    expect(c.reports.map((r) => r.status)).toEqual(["dismissed", "open"]);
  });

  test("at most 20 reports in 24 hours per person (429), counted from the clock given", async () => {
    const c = setup();
    for (let i = 0; i < LIMITS.perDay; i += 1) {
      c.reports.push({
        _id: oid(),
        reporter: c.me._id,
        targetKind: "user",
        targetId: oid(),
        status: "dismissed",
        createdAt: new Date(T0.getTime() - 3600000),
      });
    }
    await expect(c.send("listing", c.listing._id)).rejects.toMatchObject({
      statusCode: 429,
      code: "report_limit",
    });
    // older than a day no longer counts; other people are not affected
    for (const r of c.reports)
      r.createdAt = new Date(T0.getTime() - DAY - 1000);
    await c.send("listing", c.listing._id);
    for (let i = 0; i < LIMITS.perDay; i += 1) {
      c.reports.push({
        _id: oid(),
        reporter: c.me._id,
        targetKind: "user",
        targetId: oid(),
        status: "open",
        createdAt: T0,
      });
    }
    await expect(c.send("review", c.review._id)).rejects.toMatchObject({
      code: "report_limit",
    });
    // somebody else is not affected by my count
    await c.send("listing", c.listing._id, {}, c.author);
    expect(
      c.reports.filter((r) => String(r.reporter) === String(c.author._id)),
    ).toHaveLength(1);
  });

  test("a bad reason is refused before anything is looked up or stored", async () => {
    const c = setup();
    await expect(
      c.send("listing", c.listing._id, { reason: "because" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      c.send("listing", c.listing._id, { reason: "other", details: "short" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(c.reports).toHaveLength(0);
  });

  test("text typed by the reporter is stored as given, not interpreted", async () => {
    const c = setup();
    const { report } = await c.send("listing", c.listing._id, {
      reason: "spam",
      details: "<script>alert(1)</script> $where: 1",
    });
    expect(report.details).toBe("<script>alert(1)</script> $where: 1");
  });
});

describe("listMyReports", () => {
  test("own reports only, newest first, with wording for each status and no moderator detail", async () => {
    const c = setup();
    await c.send("listing", c.listing._id, { reason: "scam" });
    c.ReportModel.clock = () => new Date(T0.getTime() + 1000);
    await c.send("user", c.host._id, { reason: "offensive" });
    await c.send("review", c.review._id, {}, c.host);
    c.reports[0].status = "resolved";
    c.reports[1].status = "dismissed";
    const mine = await listMyReports(c.deps, c.me._id);
    expect(mine.map((r) => [r.kind, r.status, r.statusLabel])).toEqual([
      ["user", "dismissed", "Closed"],
      ["listing", "resolved", "Looked at"],
    ]);
    expect(mine[0]).toEqual(
      expect.objectContaining({
        target: "Asha K",
        reasonLabel: "Offensive, hateful or harassing",
        kindLabel: "Member",
      }),
    );
    expect(Object.keys(mine[0]).sort()).toEqual([
      "createdAt",
      "id",
      "kind",
      "kindLabel",
      "reasonLabel",
      "status",
      "statusLabel",
      "statusNote",
      "target",
    ]);
    expect(await listMyReports(c.deps, c.author._id)).toEqual([]);
    expect(await listMyReports(c.deps, "not-an-id")).toEqual([]);
  });
});
