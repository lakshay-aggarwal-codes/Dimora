// P18-T02: the hot queries against the declared indexes. This is the guard that
// fails when someone adds a query nothing indexes, or removes an index a query
// relies on. MongoDB's own explain is checked by tests/integration/queryPlans.db.test.js.
const {
  analyse,
  classify,
  constraints,
  deliversSort,
  declaredIndexes,
  autoName,
  hotQueries,
  reviewQueries,
  planStages,
  violations,
} = require("../../src/services/queryPlans");
const migration = require("../../scripts/migrations/010-query-indexes");
const Listing = require("../../src/models/listing");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const AuditLog = require("../../src/models/auditLog");

const idx = (name, keys) => ({ name, keys });

describe("classify / constraints", () => {
  test("what a condition can do for an index", () => {
    expect(classify("x")).toBe("eq");
    expect(classify(null)).toBe("eq");
    expect(classify(new Date())).toBe("eq");
    expect(classify({ $eq: 1 })).toBe("eq");
    expect(classify({ $in: [1, 2] })).toBe("in");
    expect(classify({ $gte: 1, $lt: 5 })).toBe("range");
    expect(classify({ $geoWithin: {} })).toBe("geo");
    expect(classify({ $ne: 1 })).toBe("other");
    expect(classify({ $nin: [1] })).toBe("other");
    expect(classify(/x/i)).toBe("other");
  });
  test("plain keys, $and and the stronger of two conditions on one field", () => {
    const c = constraints({
      a: 1,
      $and: [{ b: { $gt: 1 } }, { b: 5 }],
      $text: { $search: "x" },
    });
    expect(c.fields).toEqual({ a: "eq", b: "eq" });
    expect(c.text).toBe(true);
    expect(constraints({ $or: [{ a: 1 }] }).or).toEqual([{ a: 1 }]);
  });
});

describe("deliversSort", () => {
  const fields = { status: "eq" };
  test("equality keys first, then the sort keys in order", () => {
    expect(
      deliversSort({ status: 1, createdAt: -1, _id: -1 }, fields, {
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      deliversSort({ status: 1, createdAt: -1, _id: -1 }, fields, {
        createdAt: 1,
        _id: 1,
      }),
    ).toBe(true); // read backwards
    expect(
      deliversSort({ status: 1, createdAt: -1, _id: -1 }, fields, {
        createdAt: -1,
        _id: 1,
      }),
    ).toBe(false); // mixed directions
    expect(
      deliversSort({ status: 1, createdAt: -1 }, fields, {
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(false); // no _id in the index
    expect(
      deliversSort({ status: 1, rating: -1 }, fields, { createdAt: -1 }),
    ).toBe(false);
    expect(deliversSort({ createdAt: -1 }, {}, {})).toBe(true);
  });
  test("a key not fixed by the filter before the sort key breaks it", () => {
    expect(
      deliversSort({ cityKey: 1, price: 1 }, { status: "eq" }, { price: 1 }),
    ).toBe(false);
    expect(
      deliversSort({ cityKey: 1, price: 1 }, { cityKey: "eq" }, { price: 1 }),
    ).toBe(true);
  });
});

describe("analyse", () => {
  test("a query needs an index whose FIRST key the filter constrains", () => {
    const indexes = [idx("b_1_a_1", { b: 1, a: 1 })];
    expect(analyse({ filter: { a: 1 } }, indexes).usable).toBe(false);
    expect(analyse({ filter: { b: 1 } }, indexes).usable).toBe(true);
    expect(analyse({ filter: { b: { $gt: 1 } } }, indexes).usable).toBe(true);
    expect(analyse({ filter: { b: { $ne: 1 } } }, indexes).usable).toBe(false);
    expect(analyse({ filter: { b: /x/ } }, indexes).usable).toBe(false);
  });
  test("an empty filter can use the index that is in sort order", () => {
    expect(
      analyse({ filter: {}, sort: { c: -1 } }, [idx("c_-1", { c: -1 })]),
    ).toEqual({ usable: true, index: "c_-1", noSort: true });
    expect(
      analyse({ filter: {}, sort: { c: -1 } }, [idx("d_1", { d: 1 })]).usable,
    ).toBe(false);
  });
  test("an index that starts with a rarely selective field loses to one that starts with a person", () => {
    const indexes = [
      idx("status_1_checkOut_1", { status: 1, checkOut: 1 }),
      idx("guest_1_createdAt_-1", { guest: 1, createdAt: -1 }),
    ];
    const verdict = analyse(
      {
        filter: { guest: "g", status: "confirmed", checkOut: { $gt: 1 } },
        sort: { checkIn: 1 },
      },
      indexes,
    );
    expect(verdict.index).toBe("guest_1_createdAt_-1");
    expect(verdict.noSort).toBe(false);
  });
  test("$or: every branch needs its own index", () => {
    const indexes = [idx("g_1", { g: 1 })];
    expect(
      analyse({ filter: { g: 1, $or: [{ a: 1 }, { b: 2 }] } }, indexes).usable,
    ).toBe(true);
    expect(
      analyse({ filter: { $or: [{ g: 1 }, { h: 2 }] } }, indexes).usable,
    ).toBe(false);
  });
  test("text and geo queries need the text / 2dsphere index", () => {
    const indexes = [
      idx("t", { title: "text" }),
      idx("g", { loc: "2dsphere" }),
      idx("s", { status: 1 }),
    ];
    expect(
      analyse({ filter: { status: "p", $text: { $search: "x" } } }, indexes)
        .index,
    ).toBe("t");
    expect(
      analyse({ filter: { loc: { $geoWithin: {} } } }, indexes).index,
    ).toBe("g");
    expect(
      analyse({ filter: { status: "p" } }, [idx("t", { title: "text" })])
        .usable,
    ).toBe(false);
  });
});

describe("planStages / violations", () => {
  const plan = {
    stage: "FETCH",
    inputStage: {
      stage: "SORT",
      inputStage: { stage: "IXSCAN", indexName: "a_1" },
    },
  };
  test("walks the winning plan", () => {
    expect(planStages(plan)).toEqual([
      { stage: "FETCH" },
      { stage: "SORT" },
      { stage: "IXSCAN", indexName: "a_1" },
    ]);
    expect(
      planStages({
        stage: "OR",
        inputStages: [
          { stage: "IXSCAN", indexName: "a" },
          { stage: "IXSCAN", indexName: "b" },
        ],
      }).map((s) => s.indexName),
    ).toEqual([undefined, "a", "b"]);
  });
  test("what breaks a promise", () => {
    const measured = {
      collscan: true,
      sortInMemory: true,
      fetch: true,
      docsExamined: 5,
    };
    expect(violations({}, measured)).toEqual(
      ["collection scan", "in-memory sort"].slice(0, 1),
    );
    expect(violations({ noSort: true }, measured)).toEqual([
      "collection scan",
      "in-memory sort",
    ]);
    expect(
      violations({ scan: "admin only" }, { ...measured, sortInMemory: false }),
    ).toEqual([]);
    expect(
      violations(
        { covered: true },
        { collscan: false, sortInMemory: false, fetch: true, docsExamined: 0 },
      ),
    ).toEqual(["reads documents (not index-only)"]);
    expect(
      violations(
        { covered: true },
        { collscan: false, sortInMemory: false, fetch: false, docsExamined: 0 },
      ),
    ).toEqual([]);
  });
});

describe("declaredIndexes", () => {
  test("explicit names are kept, others get MongoDB's name, and _id is always there", () => {
    const names = declaredIndexes(Reservation).map((i) => i.name);
    expect(names).toContain("host_1_status_1_checkIn_1__id_1");
    expect(names).toContain("guest_1_createdAt_-1");
    expect(names).toContain("_id_");
    expect(autoName({ guest: 1, createdAt: -1 })).toBe("guest_1_createdAt_-1");
  });
});

describe("the hot queries (the review of P18-T02)", () => {
  const reviewed = reviewQueries();

  test("there is a query for each area the task names, each with a collection and a source", () => {
    const groups = new Set(reviewed.map((r) => r.group));
    for (const g of ["search", "availability", "host", "inbox", "trips"])
      expect(groups.has(g)).toBe(true);
    for (const r of reviewed) {
      expect(r.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(r.model).toBeTruthy();
      expect(r.source).toBeTruthy();
    }
    expect(new Set(reviewed.map((r) => r.id)).size).toBe(reviewed.length);
  });

  test("no query is left to scan the collection, except those that say why", () => {
    const scans = reviewed.filter((r) => !r.usable);
    expect(scans.map((r) => r.id)).toEqual(["users.admin_search"]);
    expect(scans[0].scan).toMatch(/admin-only/);
  });

  test("every query that promises an order from the index gets it", () => {
    const promised = new Set(
      hotQueries()
        .filter((h) => h.noSort)
        .map((h) => h.id),
    );
    expect(promised.size).toBeGreaterThan(15);
    for (const r of reviewed.filter((x) => promised.has(x.id))) {
      expect({ id: r.id, noSort: r.noSort }).toEqual({
        id: r.id,
        noSort: true,
      });
    }
  });

  test("the audit page's newest-first order comes from the index (the whole log is never sorted)", () => {
    expect(reviewed.find((r) => r.id === "audit.latest")).toEqual(
      expect.objectContaining({ index: "createdAt_-1__id_-1", noSort: true }),
    );
  });

  test("every query that sorts in memory is bounded by something said out loud", () => {
    const source = Object.fromEntries(hotQueries().map((h) => [h.id, h]));
    for (const r of reviewed) {
      if (!r.usable || r.noSort) continue;
      expect({
        id: r.id,
        bounded: Boolean(source[r.id].bounded || source[r.id].scan),
      }).toEqual({ id: r.id, bounded: true });
    }
  });

  test("the date-range availability query (search with dates) uses the date index and is index-only", () => {
    for (const id of [
      "availability.all_listings_range",
      "availability.flexible_range",
    ]) {
      const r = reviewed.find((x) => x.id === id);
      expect(r.index).toBe("date_1_listing_1_holdExpiresAt_1");
      const query = hotQueries().find((x) => x.id === id);
      expect(query.covered).toBe(true);
      // every projected field is in the index, and _id is left out
      const keys = declaredIndexes(StayNight).find(
        (i) => i.name === r.index,
      ).keys;
      for (const field of Object.keys(query.project).filter((f) => f !== "_id"))
        expect(keys).toHaveProperty(field);
      expect(query.project._id).toBe(0);
    }
  });

  test("the five search orders read the published listings already sorted", () => {
    const wanted = {
      "search.relevance": "status_1_ratingAvg_-1_ratingCount_-1__id_-1",
      "search.rating": "status_1_ratingAvg_-1_ratingCount_-1__id_-1",
      "search.newest": "status_1_createdAt_-1__id_-1",
      "search.price_asc": "status_1_pricing.nightlyMinor_1__id_1",
      "search.price_desc": "status_1_pricing.nightlyMinor_1__id_1",
    };
    for (const [id, index] of Object.entries(wanted))
      expect(reviewed.find((r) => r.id === id)).toEqual(
        expect.objectContaining({ index, noSort: true }),
      );
  });

  test("the host inbox lists use the two compound indexes, in order", () => {
    expect(reviewed.find((r) => r.id === "inbox.pending")).toEqual(
      expect.objectContaining({
        index: "host_1_status_1_holdExpiresAt_1__id_1",
        noSort: true,
      }),
    );
    expect(reviewed.find((r) => r.id === "inbox.confirmed")).toEqual(
      expect.objectContaining({
        index: "host_1_status_1_checkIn_1__id_1",
        noSort: true,
      }),
    );
  });

  test("the checker really would catch a missing index (remove one and the query is flagged)", () => {
    const query = hotQueries().find(
      (h) => h.id === "availability.all_listings_range",
    );
    const without = declaredIndexes(StayNight).filter(
      (i) => i.name !== "date_1_listing_1_holdExpiresAt_1",
    );
    expect(analyse(query, without).usable).toBe(false); // (listing, date) cannot answer a query with no listing
    const sortless = declaredIndexes(Listing).filter(
      (i) => i.name !== "status_1_createdAt_-1__id_-1",
    );
    expect(
      analyse(
        hotQueries().find((h) => h.id === "search.newest"),
        sortless,
      ).noSort,
    ).toBe(false);
  });
});

describe("migration 010 and the models agree", () => {
  const byModel = {
    listings: declaredIndexes(Listing),
    reservations: declaredIndexes(Reservation),
    staynights: declaredIndexes(StayNight),
    auditlogs: declaredIndexes(AuditLog),
  };
  test("every index it adds is declared by the model with the same keys", () => {
    for (const [collection, keys, name] of migration.ADD) {
      const declared = byModel[collection].find((i) => i.name === name);
      expect({ collection, name, found: Boolean(declared) }).toEqual({
        collection,
        name,
        found: true,
      });
      expect(declared.keys).toEqual(keys);
    }
  });
  test("every index it drops is no longer declared", () => {
    for (const [collection, name] of migration.DROP)
      expect(byModel[collection].map((i) => i.name)).not.toContain(name);
  });
});

describe("migration 010 itself", () => {
  function fakeDb({ missing = [], failWith } = {}) {
    const calls = { created: [], dropped: [] };
    const collection = (name) => ({
      createIndex: async (keys, options) =>
        calls.created.push([name, options.name]),
      dropIndex: async (indexName) => {
        if (failWith) throw failWith;
        if (missing.includes(indexName))
          throw Object.assign(new Error("index not found with name [x]"), {
            code: 27,
          });
        calls.dropped.push([name, indexName]);
      },
    });
    return { calls, collection };
  }
  test("up builds the new indexes first, then drops the old ones", async () => {
    const db = fakeDb();
    expect(await migration.up(db, {})).toEqual({ added: 8, dropped: 4 });
    expect(db.calls.created).toHaveLength(8);
    expect(db.calls.dropped).toEqual([
      ["listings", "status_1_address.city_1"],
      ["listings", "pricing.nightlyMinor_1"],
      ["reservations", "host_1_status_1"],
      ["auditlogs", "createdAt_-1"],
    ]);
  });
  test("an index that is already gone is fine, so it can run again", async () => {
    const db = fakeDb({
      missing: [
        "status_1_address.city_1",
        "pricing.nightlyMinor_1",
        "host_1_status_1",
        "createdAt_-1",
      ],
    });
    expect(await migration.up(db, {})).toEqual({ added: 8, dropped: 0 });
  });
  test("any other error stops it", async () => {
    await expect(
      migration.up(
        fakeDb({
          failWith: Object.assign(new Error("not authorized"), { code: 13 }),
        }),
        {},
      ),
    ).rejects.toThrow(/not authorized/);
  });
  test("a dry run writes nothing", async () => {
    const db = fakeDb();
    expect(await migration.up(db, { dryRun: true })).toEqual({
      toAdd: 8,
      toDrop: 4,
    });
    expect(db.calls.created).toEqual([]);
  });
  test("down brings the old indexes back and drops the new ones", async () => {
    const db = fakeDb();
    expect(await migration.down(db, {})).toEqual({ added: 4, dropped: 8 });
    expect(db.calls.created.map(([, n]) => n)).toEqual([
      "status_1_address.city_1",
      "pricing.nightlyMinor_1",
      "host_1_status_1",
      "createdAt_-1",
    ]);
  });
});
