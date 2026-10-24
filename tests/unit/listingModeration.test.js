// P14-T03: the moderation service with the models stubbed. Real MongoDB (the
// conditional updates, parallel admins): tests/integration/admin.listings.db.test.js.
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const Report = require("../../src/models/report");
const AuditLog = require("../../src/models/auditLog");
const m = require("../../src/services/listingModeration");

afterEach(() => jest.restoreAllMocks());

const admin = {
  _id: new ObjectId(),
  username: "boss",
  role: "admin",
  status: "active",
};
const NOW = new Date("2026-11-20T06:00:00.000Z");
const oid = () => new ObjectId();

const chain = (value) => {
  const calls = {};
  const c = { calls };
  for (const name of ["select", "sort", "skip", "limit", "lean", "populate"]) {
    c[name] = (...args) => {
      calls[name] = [...(calls[name] || []), args];
      return c;
    };
  }
  c.then = (res, rej) => Promise.resolve(value).then(res, rej);
  return c;
};

const published = (over = {}) => ({
  _id: oid(),
  title: "Sea house",
  status: "published",
  deletedAt: null,
  owner: oid(),
  ...over,
});

function stubListing(doc, { modified = 1 } = {}) {
  jest.spyOn(Listing, "findById").mockImplementation(() => chain(doc));
  return jest
    .spyOn(Listing, "updateOne")
    .mockResolvedValue({ modifiedCount: modified });
}

describe("cleanReason", () => {
  test("trimmed, 5 to 500 characters", () => {
    expect(m.cleanReason("  fake photos  ")).toBe("fake photos");
    for (const bad of [
      undefined,
      null,
      "",
      "    ",
      "abcd",
      5,
      ["abcde"],
      { a: 1 },
    ])
      expect(() => m.cleanReason(bad)).toThrow(m.ModerationError);
    expect(() => m.cleanReason("x".repeat(501))).toThrow(
      /500 characters or fewer/,
    );
    expect(m.cleanReason("x".repeat(500))).toHaveLength(500);
  });
  test("an optional note may be empty, but a short one is still refused", () => {
    expect(m.cleanReason(undefined, { required: false })).toBe("");
    expect(m.cleanReason("   ", { required: false })).toBe("");
    expect(() => m.cleanReason("no", { required: false })).toThrow(
      m.ModerationError,
    );
  });
});

describe("suspendListing", () => {
  test("a published listing: one conditional update; reason kept for the host; counts as reviewed; host-suspension flag cleared", async () => {
    const doc = published();
    const update = stubListing(doc);
    const done = await m.suspendListing({
      admin,
      id: String(doc._id),
      reason: "  Photos are of another place  ",
      now: NOW,
    });
    expect(update).toHaveBeenCalledTimes(1);
    const [filter, change] = update.mock.calls[0];
    expect(filter).toEqual({
      _id: doc._id,
      status: "published",
      deletedAt: null,
    });
    expect(change.$set).toEqual({
      status: "suspended",
      "moderation.suspendedAt": NOW,
      "moderation.suspendedBy": admin._id,
      "moderation.suspendReason": "Photos are of another place",
      "moderation.reviewedAt": NOW,
      "moderation.reviewedBy": admin._id,
    });
    expect(change.$unset).toEqual({ hiddenByOwnerSuspension: "" });
    expect(done.reason).toBe("Photos are of another place");
    expect(done.details).toEqual({
      title: "Sea house",
      from: "published",
      to: "suspended",
      host: String(doc.owner),
    });
  });

  test.each([
    ["no reason", { reason: undefined }, published(), /Give a reason/],
    ["a short reason", { reason: "no" }, published(), /Give a reason/],
    ["a malformed id", { id: "nope" }, published(), /does not exist/],
    ["an unknown listing", {}, null, /does not exist/],
    [
      "a deleted listing",
      {},
      published({ deletedAt: NOW }),
      /deleted by its host/,
    ],
    ["a draft", {}, published({ status: "draft" }), /Only a published listing/],
    [
      "an unpublished listing",
      {},
      published({ status: "unpublished" }),
      /Only a published listing/,
    ],
    [
      "an already suspended listing",
      {},
      published({ status: "suspended" }),
      /already suspended/,
    ],
  ])(
    "refused for %s, and nothing is changed",
    async (_name, over, doc, message) => {
      const update = stubListing(doc);
      await expect(
        m.suspendListing({
          admin,
          id: String(doc ? doc._id : oid()),
          reason: "a good enough reason",
          ...over,
        }),
      ).rejects.toThrow(message);
      expect(update).not.toHaveBeenCalled();
    },
  );

  test("another admin got there first: the conditional update changes nothing and says so", async () => {
    stubListing(published(), { modified: 0 });
    await expect(
      m.suspendListing({
        admin,
        id: String(oid()),
        reason: "a good enough reason",
      }),
    ).rejects.toThrow(/changed while you were suspending/);
  });
});

describe("restoreListing", () => {
  const suspended = (over = {}) => published({ status: "suspended", ...over });

  test("only a moderation suspension: published again, reviewed, the suspension record cleared", async () => {
    const doc = suspended();
    const update = stubListing(doc);
    const done = await m.restoreListing({
      admin,
      id: String(doc._id),
      reason: "Host fixed the photos",
      now: NOW,
    });
    const [filter, change] = update.mock.calls[0];
    expect(filter).toEqual({
      _id: doc._id,
      status: "suspended",
      deletedAt: null,
      hiddenByOwnerSuspension: { $ne: true },
    });
    expect(change.$set).toEqual({
      status: "published",
      "moderation.reviewedAt": NOW,
      "moderation.reviewedBy": admin._id,
    });
    expect(change.$unset).toEqual({
      "moderation.suspendedAt": "",
      "moderation.suspendedBy": "",
      "moderation.suspendReason": "",
    });
    expect(done.details).toEqual({
      title: "Sea house",
      from: "suspended",
      to: "published",
      host: String(doc.owner),
    });
  });

  test.each([
    [
      "a listing hidden with its host's account",
      suspended({ hiddenByOwnerSuspension: true }),
      /host's account is suspended/,
    ],
    ["a published listing", published(), /not suspended/],
    ["a deleted listing", suspended({ deletedAt: NOW }), /deleted by its host/],
    ["an unknown listing", null, /does not exist/],
  ])("refused for %s", async (_name, doc, message) => {
    const update = stubListing(doc);
    await expect(
      m.restoreListing({
        admin,
        id: String(oid()),
        reason: "a good enough reason",
      }),
    ).rejects.toThrow(message);
    expect(update).not.toHaveBeenCalled();
  });

  test("needs a reason; a lost race is reported", async () => {
    const update = stubListing(suspended());
    await expect(
      m.restoreListing({ admin, id: String(oid()), reason: "" }),
    ).rejects.toThrow(/Give a reason/);
    expect(update).not.toHaveBeenCalled();
    stubListing(suspended(), { modified: 0 });
    await expect(
      m.restoreListing({
        admin,
        id: String(oid()),
        reason: "a good enough reason",
      }),
    ).rejects.toThrow(/changed while you were restoring/);
  });
});

describe("markReviewed", () => {
  test("sets reviewedAt/By only where it is not set yet; the note is optional", async () => {
    const doc = published();
    const update = stubListing(doc);
    const done = await m.markReviewed({
      admin,
      id: String(doc._id),
      note: "",
      now: NOW,
    });
    const [filter, change] = update.mock.calls[0];
    expect(filter).toEqual({
      _id: doc._id,
      deletedAt: null,
      "moderation.reviewedAt": null,
    });
    expect(change).toEqual({
      $set: {
        "moderation.reviewedAt": NOW,
        "moderation.reviewedBy": admin._id,
      },
    });
    expect(done.reason).toBe("");
    const withNote = await m.markReviewed({
      admin,
      id: String(doc._id),
      note: "Looks fine",
    });
    expect(withNote.reason).toBe("Looks fine");
  });
  test("refused when already reviewed, deleted, unknown, malformed, or the note is too short", async () => {
    let update = stubListing(published({ moderation: { reviewedAt: NOW } }));
    await expect(m.markReviewed({ admin, id: String(oid()) })).rejects.toThrow(
      /already marked/,
    );
    update = stubListing(published({ deletedAt: NOW }));
    await expect(m.markReviewed({ admin, id: String(oid()) })).rejects.toThrow(
      /deleted/,
    );
    update = stubListing(null);
    await expect(m.markReviewed({ admin, id: String(oid()) })).rejects.toThrow(
      /does not exist/,
    );
    await expect(m.markReviewed({ admin, id: "nope" })).rejects.toThrow(
      /does not exist/,
    );
    await expect(
      m.markReviewed({ admin, id: String(oid()), note: "no" }),
    ).rejects.toThrow(/Give a reason/);
    expect(update).not.toHaveBeenCalled();
  });
  test("a lost race is reported", async () => {
    stubListing(published(), { modified: 0 });
    await expect(m.markReviewed({ admin, id: String(oid()) })).rejects.toThrow(
      /changed in the meantime/,
    );
  });
});

describe("listQueue", () => {
  const row = (over = {}) => ({
    _id: oid(),
    title: "T",
    status: "published",
    address: { city: "Goa" },
    country: "India",
    owner: { _id: oid(), username: "asha" },
    createdAt: NOW,
    ...over,
  });

  test("the new queue: published, not deleted, not yet reviewed, oldest first, 20 a page", async () => {
    const find = jest
      .spyOn(Listing, "find")
      .mockReturnValue(
        chain([row(), row({ hiddenByOwnerSuspension: undefined })]),
      );
    jest.spyOn(Listing, "countDocuments").mockResolvedValue(45);
    jest.spyOn(Report, "aggregate").mockResolvedValue([]);
    const out = await m.listQueue({ filter: "new", page: "3" });
    expect(Listing.countDocuments).toHaveBeenCalledWith({
      status: "published",
      deletedAt: null,
      "moderation.reviewedAt": null,
    });
    const query = find.mock.results[0].value.calls;
    expect(query.sort[0][0]).toEqual({ createdAt: 1, _id: 1 });
    expect(query.skip[0][0]).toBe(40);
    expect(query.limit[0][0]).toBe(20);
    expect(out).toEqual(
      expect.objectContaining({
        filter: "new",
        page: 3,
        totalPages: 3,
        total: 45,
      }),
    );
    expect(out.rows[0]).toEqual(
      expect.objectContaining({
        title: "T",
        place: "Goa, India",
        host: "asha",
        openReports: 0,
        hiddenWithHost: false,
        reviewed: false,
      }),
    );
  });

  test("the suspended queue marks listings hidden with their host's account", async () => {
    jest
      .spyOn(Listing, "find")
      .mockReturnValue(
        chain([row({ status: "suspended", hiddenByOwnerSuspension: true })]),
      );
    const count = jest.spyOn(Listing, "countDocuments").mockResolvedValue(1);
    jest.spyOn(Report, "aggregate").mockResolvedValue([]);
    const out = await m.listQueue({ filter: "suspended" });
    expect(count).toHaveBeenCalledWith({
      status: "suspended",
      deletedAt: null,
    });
    expect(out.rows[0].hiddenWithHost).toBe(true);
  });

  test("open report counts are shown on each row", async () => {
    const a = row();
    jest.spyOn(Listing, "find").mockReturnValue(chain([a]));
    jest.spyOn(Listing, "countDocuments").mockResolvedValue(1);
    const agg = jest
      .spyOn(Report, "aggregate")
      .mockResolvedValue([{ _id: a._id, count: 3 }]);
    const out = await m.listQueue({ filter: "new" });
    expect(out.rows[0].openReports).toBe(3);
    expect(agg.mock.calls[0][0][0].$match).toEqual({
      targetKind: "listing",
      status: "open",
      targetId: { $in: [a._id] },
    });
  });

  test("the reported queue: most reports first, then the most recent; deleted listings left out; paged", async () => {
    const [a, b, c, gone] = [oid(), oid(), oid(), oid()];
    jest.spyOn(Report, "aggregate").mockResolvedValue([
      { _id: a, count: 1, latest: new Date("2026-11-03") },
      { _id: b, count: 3, latest: new Date("2026-11-01") },
      { _id: c, count: 1, latest: new Date("2026-11-05") },
      { _id: gone, count: 9, latest: new Date("2026-11-06") },
    ]);
    jest.spyOn(Listing, "find").mockImplementation((query) => {
      const ids = query._id.$in;
      const alive = [a, b, c].filter((id) =>
        ids.some((x) => String(x) === String(id)),
      );
      return chain(
        query.deletedAt === null
          ? alive.map((_id) => ({ _id }))
          : alive.map((_id) =>
              row({ _id, title: `L-${String(_id).slice(-4)}` }),
            ),
      );
    });
    const out = await m.listQueue({ filter: "reported" });
    expect(out.total).toBe(3);
    expect(out.rows.map((r) => [r.id, r.openReports])).toEqual([
      [String(b), 3],
      [String(c), 1],
      [String(a), 1],
    ]);
  });

  test("an unknown filter is the reported queue; a hostile page number is page 1", async () => {
    jest.spyOn(Report, "aggregate").mockResolvedValue([]);
    jest.spyOn(Listing, "find").mockReturnValue(chain([]));
    for (const filter of [undefined, "everything", ["new"], "__proto__"]) {
      expect((await m.listQueue({ filter })).filter).toBe("reported");
    }
    expect((await m.listQueue({ filter: "reported", page: "-4" })).page).toBe(
      1,
    );
    expect(
      (await m.listQueue({ filter: "reported", page: { $gt: 1 } })).page,
    ).toBe(1);
  });
});

describe("getListingForModeration", () => {
  test("null for a malformed or unknown id", async () => {
    expect(await m.getListingForModeration("nope")).toBeNull();
    expect(await m.getListingForModeration(undefined)).toBeNull();
    jest.spyOn(Listing, "findById").mockReturnValue(chain(null));
    expect(await m.getListingForModeration(String(oid()))).toBeNull();
  });

  test("a summary with open reports and history; never the host's email", async () => {
    const doc = {
      ...published({
        owner: { _id: oid(), username: "asha", status: "active" },
      }),
      address: { city: "Goa", state: "Goa" },
      country: "India",
      description: "d".repeat(500),
      pricing: { nightlyMinor: 250000, currency: "INR" },
      images: [{ url: "a" }, { url: "b" }],
      moderation: {
        suspendedAt: NOW,
        suspendedBy: { username: "boss" },
        suspendReason: "Fake photos",
      },
      status: "suspended",
    };
    const q = chain(doc);
    jest.spyOn(Listing, "findById").mockReturnValue(q);
    jest.spyOn(Report, "find").mockReturnValue(
      chain([
        {
          reporter: { username: "ravi" },
          reason: "scam",
          details: "<b>fake</b>",
          createdAt: NOW,
        },
        { reporter: null, reason: "weird", createdAt: NOW },
      ]),
    );
    jest
      .spyOn(AuditLog, "find")
      .mockReturnValue(chain([{ action: "listing.suspend" }]));
    const page = await m.getListingForModeration(String(doc._id));
    expect(page.summary).toEqual(
      expect.objectContaining({
        title: "Sea house",
        status: "suspended",
        place: "Goa, Goa, India",
        nightlyMinor: 250000,
        photos: 2,
        suspendedBy: "boss",
        suspendReason: "Fake photos",
        hiddenWithHost: false,
      }),
    );
    expect(page.summary.descriptionExcerpt).toHaveLength(401);
    expect(page.reports).toEqual([
      expect.objectContaining({
        reporter: "ravi",
        reason: "Scam or fraud",
        details: "<b>fake</b>",
      }),
      expect.objectContaining({
        reporter: "(deleted account)",
        reason: "weird",
        details: "",
      }),
    ]);
    expect(page.history).toHaveLength(1);
    const populateOwner = q.calls.populate.find((c) => c[0] === "owner");
    expect(populateOwner[1]).toBe("username displayName status");
    expect(JSON.stringify(q.calls.select)).not.toMatch(/email|hash|salt/);
  });
});
