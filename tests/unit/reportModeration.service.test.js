// P14-T04: the reports queue (list, open one, close it), with in-memory fakes.
const { ObjectId } = require("mongoose").Types;
const queue = require("../../src/services/reportModeration");

const ADMIN = { _id: new ObjectId(), role: "admin", status: "active" };
const NOW = new Date("2026-10-24T10:00:00Z");

const report = (extra = {}) => ({
  _id: new ObjectId(),
  reporter: { _id: new ObjectId(), username: "ann" },
  targetKind: "listing",
  targetId: new ObjectId(),
  targetLabel: "Sea house",
  reason: "scam",
  details: "looks fake",
  status: "open",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...extra,
});

function fakeReports(rows) {
  const calls = { find: [], count: [], aggregate: [] };
  const match = (r, f) =>
    Object.entries(f).every(([k, v]) => {
      if (k === "_id" && v && v.$ne) return String(r._id) !== String(v.$ne);
      if (k === "_id") return String(r._id) === String(v);
      if (v && typeof v === "object" && v.$in)
        return v.$in.some((x) => String(x) === String(r[k]));
      return String(r[k]) === String(v);
    });
  const model = {
    rows,
    calls,
    countDocuments: jest.fn(
      async (f) => rows.filter((r) => match(r, f)).length,
    ),
    find: jest.fn((f) => {
      calls.find.push(f);
      let list = rows.filter((r) => match(r, f));
      const q = {
        sort: (s) => {
          calls.sort = s;
          return q;
        },
        skip: (n) => ((list = list.slice(n)), (calls.skip = n), q),
        limit: (n) => ((list = list.slice(0, n)), q),
        populate: () => q,
        select: () => q,
        lean: async () => list,
      };
      return q;
    }),
    findById: jest.fn((id) => {
      const doc = rows.find((r) => String(r._id) === String(id)) || null;
      const q = { populate: () => q, lean: async () => doc };
      return q;
    }),
    aggregate: jest.fn(async () => {
      const groups = new Map();
      for (const r of rows.filter((x) => x.status === "open")) {
        const key = `${r.targetKind}|${r.targetId}`;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      return [...groups].map(([key, count]) => {
        const [kind, id] = key.split("|");
        return { _id: { kind, id }, count };
      });
    }),
    exists: jest.fn(async (f) =>
      rows.some((r) => match(r, f)) ? { _id: 1 } : null,
    ),
    findOneAndUpdate: jest.fn((f, u) => {
      const doc = rows.find(
        (r) => String(r._id) === String(f._id) && r.status === f.status,
      );
      if (doc) Object.assign(doc, u.$set);
      return { lean: async () => (doc ? { ...doc } : null) };
    }),
    updateMany: jest.fn(async (f, u) => {
      let n = 0;
      for (const r of rows) {
        if (
          r.targetKind === f.targetKind &&
          String(r.targetId) === String(f.targetId) &&
          r.status === f.status
        ) {
          Object.assign(r, u.$set);
          n += 1;
        }
      }
      return { modifiedCount: n };
    }),
  };
  return model;
}

describe("listReports", () => {
  test("open by default, oldest first; only open ones are counted in the tab badge", async () => {
    const rows = [
      report({ createdAt: new Date("2026-10-03") }),
      report({ createdAt: new Date("2026-10-01") }),
      report({ status: "resolved", resolvedAt: NOW }),
    ];
    const model = fakeReports(rows);
    const result = await queue.listReports({ ReportModel: model });
    expect(result).toMatchObject({
      status: "open",
      kind: "",
      total: 2,
      openTotal: 2,
      page: 1,
      totalPages: 1,
    });
    expect(model.calls.find[0]).toEqual({ status: "open" });
    expect(model.calls.sort).toEqual({ createdAt: 1, _id: 1 });
  });

  test("closed ones are newest-closed first, and the kind filter is applied", async () => {
    const model = fakeReports([
      report({ status: "dismissed", resolvedAt: NOW, targetKind: "review" }),
    ]);
    const result = await queue.listReports({
      ReportModel: model,
      status: "dismissed",
      kind: "review",
    });
    expect(model.calls.find[0]).toEqual({
      status: "dismissed",
      targetKind: "review",
    });
    expect(model.calls.sort).toEqual({ resolvedAt: -1, _id: -1 });
    expect(result.rows[0]).toMatchObject({
      status: "dismissed",
      kindLabel: "Review",
    });
  });

  test.each([
    [undefined],
    [""],
    ["all"],
    ["'; drop"],
    [["open"]],
    [{ $ne: 1 }],
  ])("a status or kind of %j falls back to the defaults", async (bad) => {
    const model = fakeReports([]);
    const result = await queue.listReports({
      ReportModel: model,
      status: bad,
      kind: bad,
    });
    expect(result.status).toBe("open");
    expect(result.kind).toBe("");
    expect(model.calls.find[0]).toEqual({ status: "open" }); // nothing from the query string reached the filter
  });

  test("the row shows how many open reports its target has", async () => {
    const target = new ObjectId();
    const rows = [
      report({ targetId: target }),
      report({ targetId: target, reporter: { username: "bob" } }),
      report(),
    ];
    const model = fakeReports(rows);
    const result = await queue.listReports({ ReportModel: model });
    expect(result.rows.filter((r) => r.openOnTarget === 2)).toHaveLength(2);
    expect(result.rows.filter((r) => r.openOnTarget === 1)).toHaveLength(1);
  });

  test("paging: 20 a page, a page past the end is the last page", async () => {
    const rows = Array.from({ length: 45 }, (_, i) =>
      report({ createdAt: new Date(2026, 0, 1 + i) }),
    );
    const model = fakeReports(rows);
    const result = await queue.listReports({ ReportModel: model, page: "99" });
    expect(result).toMatchObject({ page: 3, totalPages: 3, total: 45 });
    expect(result.rows).toHaveLength(5);
  });

  test("a report whose reporter account is gone still lists", async () => {
    const model = fakeReports([report({ reporter: null })]);
    expect(
      (await queue.listReports({ ReportModel: model })).rows[0].reporter,
    ).toBe("(removed account)");
  });
});

describe("closeReport", () => {
  const run = (model, over = {}) =>
    queue.closeReport({
      admin: ADMIN,
      id: String(model.rows[0]._id),
      outcome: "resolve",
      note: "Hid the review.",
      now: NOW,
      ReportModel: model,
      ...over,
    });

  test("resolve: closed with who, when and the note; the details are for the audit row", async () => {
    const model = fakeReports([report()]);
    const done = await run(model);
    expect(model.rows[0]).toMatchObject({
      status: "resolved",
      resolvedAt: NOW,
      resolvedBy: ADMIN._id,
      resolutionNote: "Hid the review.",
    });
    expect(done).toMatchObject({
      outcome: "resolved",
      note: "Hid the review.",
      closedOthers: 0,
    });
    expect(done.details).toEqual({
      outcome: "resolved",
      targetKind: "listing",
      targetId: String(model.rows[0].targetId),
      closedOthers: 0,
    });
  });

  test("dismiss", async () => {
    const model = fakeReports([report()]);
    await run(model, { outcome: "dismiss", note: "Nothing wrong here." });
    expect(model.rows[0].status).toBe("dismissed");
  });

  test("a closed report cannot be closed again, and two admins at once close it once", async () => {
    const model = fakeReports([report()]);
    const results = await Promise.allSettled([
      run(model),
      run(model, { outcome: "dismiss" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results.find((r) => r.status === "rejected").reason.message,
    ).toContain("already closed");
  });

  test("closeOthers closes every other open report about the same thing, and nothing else", async () => {
    const target = new ObjectId();
    const rows = [
      report({ targetId: target }),
      report({ targetId: target }),
      report({ targetId: target, status: "dismissed" }),
      report({ targetId: new ObjectId() }),
      report({ targetId: target, targetKind: "review" }),
    ];
    const model = fakeReports(rows);
    const done = await run(model, { closeOthers: true });
    expect(done.closedOthers).toBe(1);
    expect(rows.map((r) => r.status)).toEqual([
      "resolved",
      "resolved",
      "dismissed",
      "open",
      "open",
    ]);
  });

  test("without closeOthers the others stay open", async () => {
    const target = new ObjectId();
    const model = fakeReports([
      report({ targetId: target }),
      report({ targetId: target }),
    ]);
    await run(model);
    expect(model.rows.map((r) => r.status)).toEqual(["resolved", "open"]);
  });

  test.each([[undefined], [""], ["   "], ["no"], ["x".repeat(501)], [5]])(
    "a note of %j is refused and nothing changes",
    async (note) => {
      const model = fakeReports([report()]);
      await expect(run(model, { note })).rejects.toBeInstanceOf(
        queue.ReportAdminError,
      );
      expect(model.rows[0].status).toBe("open");
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test.each([["close"], [undefined], ["resolved"], ["$ne"]])(
    "an outcome of %j is refused",
    async (outcome) => {
      const model = fakeReports([report()]);
      await expect(run(model, { outcome })).rejects.toThrow(
        "Choose resolve or dismiss",
      );
    },
  );

  test("a bad or missing id is a plain refusal", async () => {
    const model = fakeReports([report()]);
    await expect(run(model, { id: "nope" })).rejects.toThrow("does not exist");
    await expect(run(model, { id: String(new ObjectId()) })).rejects.toThrow(
      "does not exist",
    );
  });
});

describe("getReport: the reported thing, by kind", () => {
  const models = (over = {}) => ({
    ListingModel: {
      findById: () => ({
        select: () => ({
          lean: async () => ({ title: "Sea house", status: "published" }),
        }),
      }),
      findOne: () => ({
        select: () => ({ lean: async () => ({ title: "Sea house" }) }),
      }),
    },
    ReviewModel: {
      findById: () => ({
        populate: () => ({
          lean: async () => ({
            _id: new ObjectId(),
            rating: 2,
            comment: "Bad <b>x</b>",
            author: { _id: new ObjectId(), username: "guest1" },
            listing: new ObjectId(),
            status: "visible",
            createdAt: NOW,
          }),
        }),
      }),
    },
    UserModel: {
      findById: () => ({
        select: () => ({
          lean: async () => ({ username: "spammer", status: "active" }),
        }),
      }),
    },
    ...over,
  });
  const get = (r, over) =>
    queue.getReport(String(r._id), {
      ReportModel: fakeReports([
        r,
        report({
          targetKind: r.targetKind,
          targetId: r.targetId,
          status: "dismissed",
        }),
      ]),
      ...models(over),
    });

  test("a listing links to its moderation page", async () => {
    const r = report();
    const page = await get(r);
    expect(page.target).toMatchObject({
      kind: "listing",
      title: "Sea house",
      status: "published",
      url: `/admin/listings/${r.targetId}`,
    });
    expect(page.report).toMatchObject({
      kindLabel: "Listing",
      reasonLabel: "Scam or fraud",
      details: "looks fake",
      reporter: "ann",
    });
    expect(page.others).toHaveLength(1);
    expect(page.openOthers).toBe(0);
  });

  test("a review shows its text, author and listing", async () => {
    const page = await get(report({ targetKind: "review" }));
    expect(page.target).toMatchObject({
      kind: "review",
      rating: 2,
      comment: "Bad <b>x</b>",
      author: "guest1",
      listingTitle: "Sea house",
      hidden: false,
    });
  });

  test("a hidden review says so and why", async () => {
    const hidden = {
      findById: () => ({
        populate: () => ({
          lean: async () => ({
            _id: new ObjectId(),
            rating: 1,
            comment: "c",
            status: "hidden",
            moderation: { hiddenReason: "Private data" },
            author: null,
          }),
        }),
      }),
    };
    const page = await get(report({ targetKind: "review" }), {
      ReviewModel: hidden,
      ListingModel: models().ListingModel,
    });
    expect(page.target).toMatchObject({
      hidden: true,
      hiddenReason: "Private data",
      author: "(removed account)",
    });
  });

  test("a member links to their page", async () => {
    const r = report({ targetKind: "user" });
    expect((await get(r)).target).toMatchObject({
      kind: "user",
      username: "spammer",
      url: `/admin/users/${r.targetId}`,
    });
  });

  test("a message report cannot be opened yet", async () => {
    expect((await get(report({ targetKind: "message" }))).target).toEqual({
      kind: "message",
      unavailable: true,
    });
  });

  test("a target that is gone is said to be gone", async () => {
    const gone = {
      findById: () => ({ select: () => ({ lean: async () => null }) }),
    };
    expect((await get(report(), { ListingModel: gone })).target).toEqual({
      kind: "listing",
      gone: true,
    });
  });

  test("a closed report shows who closed it and the note; a bad id is null", async () => {
    const r = report({
      status: "resolved",
      resolvedAt: NOW,
      resolvedBy: { username: "boss" },
      resolutionNote: "Done.",
    });
    expect((await get(r)).report).toMatchObject({
      status: "resolved",
      resolvedBy: "boss",
      note: "Done.",
    });
    expect(
      await queue.getReport("nope", { ReportModel: fakeReports([]) }),
    ).toBeNull();
  });
});
