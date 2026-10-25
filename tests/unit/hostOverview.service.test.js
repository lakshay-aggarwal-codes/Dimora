// P13-T01: the host overview numbers, with in-memory fakes.
const { ObjectId } = require("mongoose").Types;
const ov = require("../../src/services/hostOverview");
const { parseDateOnly } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
const HOST = new ObjectId();
// Tuesday 20 Oct 2026, 11:30 in Kolkata. Today is 2026-10-20.
const NOW = new Date("2026-10-20T06:00:00Z");
const HOUR = 3600000;

const lines = (nights, cleaning, fee, tax) => [
  {
    code: "nights",
    unitMinor: 250000,
    quantity: nights,
    amountMinor: nights * 250000,
  },
  ...(cleaning ? [{ code: "cleaning", amountMinor: cleaning }] : []),
  { code: "service_fee", amountMinor: fee },
  { code: "tax", amountMinor: tax },
];
const stay = (extra = {}) => ({
  _id: new ObjectId(),
  host: HOST,
  status: "confirmed",
  guests: 2,
  guest: { _id: new ObjectId(), displayName: "Ravi" },
  checkIn: d("2026-10-22"),
  checkOut: d("2026-10-25"),
  listingSnapshot: { title: "Sea house" },
  pricingSnapshot: {
    lines: lines(3, 50000, 80000, 100000),
    totalMinor: 980000,
  },
  ...extra,
});

function deps({ listings = [], reservations = [], nights = [] } = {}) {
  const calls = { reservations: [], nights: [], listings: [] };
  const match = (r, f) =>
    Object.entries(f).every(([k, v]) => {
      if (k === "$or") return v.some((alt) => match(r, alt));
      if (k === "_id" && v.$in)
        return v.$in.some((x) => String(x) === String(r._id));
      if (k === "status" && v.$in) return v.$in.includes(r.status);
      if (
        v &&
        typeof v === "object" &&
        ("$gte" in v || "$lt" in v || "$gt" in v)
      ) {
        const x = r[k];
        return (
          x !== undefined &&
          (v.$gte === undefined || x >= v.$gte) &&
          (v.$lt === undefined || x < v.$lt) &&
          (v.$gt === undefined || x > v.$gt)
        );
      }
      return String(r[k]) === String(v);
    });
  const chain = (rows) => {
    const q = {
      sort: () => q,
      limit: () => q,
      select: () => q,
      populate: () => q,
      lean: async () => rows,
    };
    return q;
  };
  return {
    calls,
    ListingModel: { find: (f) => (calls.listings.push(f), chain(listings)) },
    ReservationModel: {
      find: (f) => (
        calls.reservations.push(f),
        chain(reservations.filter((r) => match(r, f)))
      ),
    },
    StayNightModel: { find: (f) => (calls.nights.push(f), chain(nights)) },
  };
}
const run = (dep) => ov.overview(dep, HOST, { now: NOW });
const listing = (status = "published") => ({ _id: new ObjectId(), status });

describe("hostReceivableMinor", () => {
  test("nights, weekend nights and cleaning; never the service fee or the tax", () => {
    expect(
      ov.hostReceivableMinor({ lines: lines(3, 50000, 80000, 100000) }),
    ).toBe(800000);
    expect(
      ov.hostReceivableMinor({
        lines: [
          { code: "weekend_nights", amountMinor: 300000 },
          { code: "nights", amountMinor: 250000 },
        ],
      }),
    ).toBe(550000);
  });
  test.each([
    [undefined],
    [null],
    [{}],
    [{ lines: "x" }],
    [
      {
        lines: [
          null,
          { code: "nights" },
          { code: "nights", amountMinor: 1.5 },
          { code: "nights", amountMinor: -5 },
          { code: "cleaning", amountMinor: "100" },
        ],
      },
    ],
  ])("unreadable data %j is 0", (snapshot) => {
    expect(ov.hostReceivableMinor(snapshot)).toBe(0);
  });
});

describe("occupancyPercent", () => {
  test("a whole percent, or null with nothing to divide by", () => {
    expect(ov.occupancyPercent(15, 30)).toBe(50);
    expect(ov.occupancyPercent(1, 3)).toBe(33);
    expect(ov.occupancyPercent(0, 30)).toBe(0);
    expect(ov.occupancyPercent(0, 0)).toBeNull();
    expect(ov.occupancyPercent(5, -3)).toBeNull();
  });
});

describe("pending requests", () => {
  test("only requests whose hold is still running count; the soonest expiry is reported", async () => {
    const rows = [
      stay({
        status: "pending",
        holdExpiresAt: new Date(NOW.getTime() + 5 * HOUR),
      }),
      stay({
        status: "pending",
        holdExpiresAt: new Date(NOW.getTime() + 2 * HOUR),
      }),
      stay({
        status: "pending",
        holdExpiresAt: new Date(NOW.getTime() - HOUR),
      }),
      stay({ status: "confirmed" }),
    ];
    const dep = deps({
      listings: [listing()],
      reservations: rows.sort(
        (a, b) => (a.holdExpiresAt || 0) - (b.holdExpiresAt || 0),
      ),
    });
    const result = await run(dep);
    expect(result.pending.count).toBe(2);
    expect(result.pending.soonestExpiry).toEqual(
      new Date(NOW.getTime() + 2 * HOUR),
    );
  });
  test("none waiting", async () => {
    expect((await run(deps({ listings: [listing()] }))).pending).toEqual({
      count: 0,
      soonestExpiry: null,
      capped: false,
    });
  });
  test("every query is for this host", async () => {
    const dep = deps({ listings: [listing()] });
    await run(dep);
    for (const f of dep.calls.reservations) expect(f.host).toBe(HOST);
    expect(dep.calls.listings[0]).toMatchObject({
      owner: HOST,
      deletedAt: null,
    });
  });
});

describe("the next 7 days", () => {
  test("check-ins today through day 6 and check-outs in the same window; day 7 is outside", async () => {
    const rows = [
      stay({ checkIn: d("2026-10-20"), checkOut: d("2026-10-22") }),
      stay({ checkIn: d("2026-10-26"), checkOut: d("2026-10-30") }),
      stay({ checkIn: d("2026-10-27"), checkOut: d("2026-10-28") }),
      stay({ checkIn: d("2026-10-10"), checkOut: d("2026-10-21") }),
      stay({ checkIn: d("2026-10-01"), checkOut: d("2026-10-05") }),
      stay({
        status: "pending",
        checkIn: d("2026-10-21"),
        checkOut: d("2026-10-22"),
      }),
    ];
    const result = await run(
      deps({ listings: [listing()], reservations: rows }),
    );
    expect(result.week).toMatchObject({ days: 7, checkIns: 2, checkOuts: 2 });
    expect(result.week.upcomingCheckIns.map((s) => s.date)).toEqual([
      d("2026-10-20"),
      d("2026-10-26"),
    ]);
    expect(result.week.upcomingCheckOuts).toHaveLength(2);
    expect(result.week.upcomingCheckIns[0]).toMatchObject({
      guest: "Ravi",
      title: "Sea house",
      guests: 2,
    });
  });
  test("only the first five are listed, all are counted", async () => {
    const rows = Array.from({ length: 8 }, () =>
      stay({ checkIn: d("2026-10-21"), checkOut: d("2026-11-20") }),
    );
    const result = await run(
      deps({ listings: [listing()], reservations: rows }),
    );
    expect(result.week.checkIns).toBe(8);
    expect(result.week.upcomingCheckIns).toHaveLength(5);
  });
  test("a guest account that is gone is 'A guest'", async () => {
    const result = await run(
      deps({
        listings: [listing()],
        reservations: [
          stay({ guest: new ObjectId(), checkIn: d("2026-10-21") }),
        ],
      }),
    );
    expect(result.week.upcomingCheckIns[0].guest).toBe("A guest");
  });
});

describe("estimated earnings", () => {
  test("confirmed and completed stays that start this month; the host's part only", async () => {
    const rows = [
      stay({
        status: "confirmed",
        checkIn: d("2026-10-05"),
        checkOut: d("2026-10-08"),
      }),
      stay({
        status: "completed",
        checkIn: d("2026-10-12"),
        checkOut: d("2026-10-14"),
        pricingSnapshot: {
          lines: lines(2, 0, 50000, 90000),
          totalMinor: 640000,
        },
      }),
      stay({
        status: "confirmed",
        checkIn: d("2026-11-01"),
        checkOut: d("2026-11-03"),
      }), // next month
      stay({
        status: "confirmed",
        checkIn: d("2026-09-30"),
        checkOut: d("2026-10-02"),
      }), // started last month
      stay({
        status: "pending",
        checkIn: d("2026-10-10"),
        checkOut: d("2026-10-12"),
      }),
      stay({
        status: "cancelled_by_guest",
        checkIn: d("2026-10-10"),
        checkOut: d("2026-10-12"),
      }),
    ];
    const dep = deps({ listings: [listing()], reservations: rows });
    const result = await run(dep);
    expect(result.earnings).toMatchObject({
      estimateMinor: 800000 + 500000,
      stays: 2,
    });
    expect(result.earnings.monthStart).toEqual(d("2026-10-01"));
    const query = dep.calls.reservations[2];
    expect(query.status.$in.sort()).toEqual(["completed", "confirmed"]);
  });
  test("no stays: zero, not a crash", async () => {
    expect((await run(deps({ listings: [listing()] }))).earnings).toMatchObject(
      { estimateMinor: 0, stays: 0 },
    );
  });
});

describe("occupancy, next 30 nights", () => {
  const a = listing();
  const b = listing();
  const unpublished = listing("unpublished");
  const confirmed = stay({ status: "confirmed" });
  const completed = stay({ status: "completed" });
  const pending = stay({ status: "pending" });
  const nightRows = (n, source, extra = {}) =>
    Array.from({ length: n }, () => ({
      listing: a._id,
      date: d("2026-10-25"),
      source,
      ...extra,
    }));

  test("booked / (published listings x 30 - blocked nights); pending requests are in neither part", async () => {
    const rows = [
      ...nightRows(6, { kind: "reservation", id: confirmed._id }),
      ...nightRows(2, { kind: "reservation", id: completed._id }),
      ...nightRows(
        5,
        { kind: "reservation", id: pending._id },
        { holdExpiresAt: new Date(NOW.getTime() + HOUR) },
      ),
      ...nightRows(10, { kind: "block", id: new ObjectId() }),
    ];
    const result = await run(
      deps({
        listings: [a, b, unpublished],
        reservations: [confirmed, completed, pending],
        nights: rows,
      }),
    );
    expect(result.occupancy).toMatchObject({
      listings: 2,
      bookedNights: 8,
      blockedNights: 10,
      availableNights: 50,
      days: 30,
    });
    expect(result.occupancy.percent).toBe(16);
  });

  test("a lapsed request hold and a night of another host's reservation are not booked", async () => {
    const rows = [
      ...nightRows(
        3,
        { kind: "reservation", id: pending._id },
        { holdExpiresAt: new Date(NOW.getTime() - HOUR) },
      ),
      ...nightRows(3, { kind: "reservation", id: new ObjectId() }),
    ];
    const result = await run(
      deps({ listings: [a], reservations: [pending], nights: rows }),
    );
    expect(result.occupancy.bookedNights).toBe(0);
    expect(result.occupancy.percent).toBe(0);
  });

  test("the ledger is asked once, for published listings only, for the 30 nights from today", async () => {
    const dep = deps({ listings: [a, unpublished], nights: [] });
    await run(dep);
    expect(dep.calls.nights).toHaveLength(1);
    expect(dep.calls.nights[0].listing.$in.map(String)).toEqual([
      String(a._id),
    ]);
    expect(dep.calls.nights[0].date).toEqual({
      $gte: d("2026-10-20"),
      $lt: d("2026-11-19"),
    });
  });

  test("no published listing: no ledger query and no percentage", async () => {
    const dep = deps({ listings: [unpublished] });
    const result = await run(dep);
    expect(dep.calls.nights).toHaveLength(0);
    expect(result.occupancy).toMatchObject({ percent: null, listings: 0 });
  });

  test("every night blocked: no percentage rather than a division by zero", async () => {
    const rows = Array.from({ length: 30 }, () => ({
      listing: a._id,
      date: d("2026-10-25"),
      source: { kind: "block", id: new ObjectId() },
    }));
    const result = await run(deps({ listings: [a], nights: rows }));
    expect(result.occupancy).toMatchObject({
      percent: null,
      availableNights: 0,
    });
  });
});

describe("no listings", () => {
  test("zeros everywhere and no ledger query", async () => {
    const dep = deps();
    const result = await run(dep);
    expect(result).toMatchObject({
      listingCount: 0,
      pending: { count: 0 },
      week: { checkIns: 0, checkOuts: 0 },
      earnings: { estimateMinor: 0 },
      occupancy: { percent: null },
    });
    expect(dep.calls.nights).toHaveLength(0);
  });
});
