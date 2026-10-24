// P13-T02: the host's all-listings month calendar, with in-memory fakes.
const { ObjectId } = require("mongoose").Types;
const cal = require("../../src/services/hostCalendar");
const { parseDateOnly } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
const HOST = new ObjectId();
// 20 Oct 2026, 11:30 in Kolkata.
const NOW = new Date("2026-10-20T06:00:00Z");

const listing = (title, extra = {}) => ({
  _id: new ObjectId(),
  title,
  status: "published",
  owner: HOST,
  ...extra,
});
const night = (l, date, source, extra = {}) => ({
  listing: l._id,
  date: d(date),
  source,
  ...extra,
});
const reservation = (extra = {}) => ({
  _id: new ObjectId(),
  host: HOST,
  status: "confirmed",
  guest: { _id: new ObjectId(), displayName: "Ravi" },
  ...extra,
});

function deps({ listings = [], nights = [], reservations = [] } = {}) {
  const calls = { listings: [], nights: [], reservations: [] };
  const chain = (rows, record) => (filter) => {
    record.push(filter);
    const q = {
      select: () => q,
      sort: () => q,
      limit: (n) => ((q.n = n), q),
      populate: () => q,
      lean: async () => (q.n ? rows.slice(0, q.n) : rows),
    };
    return q;
  };
  return {
    calls,
    ListingModel: { find: chain(listings, calls.listings) },
    StayNightModel: { find: chain(nights, calls.nights) },
    ReservationModel: { find: chain(reservations, calls.reservations) },
  };
}
const overview = (dep, month, over = {}) =>
  cal.monthOverview(dep, HOST, month, { now: NOW, ...over });
const cell = (view, rowIndex, day) => view.rows[rowIndex].cells[day - 1];

describe("month resolution", () => {
  test("a month, the current month by default, kept inside 12 months back and the booking horizon", async () => {
    expect((await overview(deps())).monthKey).toBe("2026-10");
    expect((await overview(deps(), "2026-12")).monthKey).toBe("2026-12");
    for (const bad of ["x", "2026-13", "", "2026-1", undefined])
      expect((await overview(deps(), bad)).monthKey).toBe("2026-10");
    expect((await overview(deps(), "2019-01")).monthKey).toBe("2025-10");
    expect((await overview(deps(), "2040-01")).monthKey).toBe("2027-10");
  });
  test("previous and next keys disappear at the ends", async () => {
    expect(await overview(deps(), "2025-10")).toMatchObject({
      prevKey: null,
      nextKey: "2025-11",
    });
    expect(await overview(deps(), "2027-10")).toMatchObject({
      prevKey: "2027-09",
      nextKey: null,
    });
    expect(await overview(deps(), "2026-10")).toMatchObject({
      prevKey: "2026-09",
      nextKey: "2026-11",
    });
  });
  test("the label and the days of the month", async () => {
    const view = await overview(deps(), "2026-02");
    expect(view.label).toBe("February 2026");
    expect(view.days).toHaveLength(28);
    expect(view.days[0]).toMatchObject({
      day: 1,
      iso: "2026-02-01",
      weekday: { long: "Sunday" },
      weekend: true,
      today: false,
    });
    expect(
      (await overview(deps(), "2026-10")).days.find((x) => x.today).iso,
    ).toBe("2026-10-20");
  });
});

describe("which listings", () => {
  test("only this host's, not drafts, not deleted, in title order (the query says so)", async () => {
    const dep = deps({ listings: [listing("A"), listing("B")] });
    await overview(dep);
    const filter = dep.calls.listings[0];
    expect(filter).toMatchObject({ owner: HOST, deletedAt: null });
    expect(filter.status.$in.sort()).toEqual([
      "published",
      "suspended",
      "unpublished",
    ]);
  });
  test("no listings: no ledger query at all", async () => {
    const dep = deps();
    const view = await overview(dep);
    expect(view.rows).toEqual([]);
    expect(dep.calls.nights).toHaveLength(0);
  });
  test("more than 50: the first 50 and a note", async () => {
    const many = Array.from({ length: 51 }, (_, i) => listing(`L${i}`));
    const view = await overview(deps({ listings: many }));
    expect(view.rows).toHaveLength(50);
    expect(view.truncated).toBe(true);
  });
  test("one query for all listings and the month, not one per listing", async () => {
    const a = listing("A");
    const b = listing("B");
    const dep = deps({ listings: [a, b] });
    await overview(dep, "2026-11");
    expect(dep.calls.nights).toHaveLength(1);
    expect(dep.calls.nights[0].listing.$in.map(String)).toEqual([
      String(a._id),
      String(b._id),
    ]);
    expect(dep.calls.nights[0].date).toEqual({
      $gte: d("2026-11-01"),
      $lt: d("2026-12-01"),
    });
  });
});

describe("the cells", () => {
  const a = listing("Sea house");
  const confirmed = reservation();
  const pending = reservation({ status: "pending" });
  const done = reservation({ status: "completed" });
  const nights = [
    night(a, "2026-11-03", { kind: "reservation", id: confirmed._id }),
    night(a, "2026-11-04", { kind: "reservation", id: confirmed._id }),
    night(
      a,
      "2026-11-10",
      { kind: "reservation", id: pending._id },
      { holdExpiresAt: new Date("2026-10-21T06:00:00Z") },
    ),
    night(a, "2026-11-12", { kind: "block", id: new ObjectId() }),
    night(a, "2026-11-20", { kind: "reservation", id: done._id }),
  ];
  const run = () =>
    overview(
      deps({ listings: [a], nights, reservations: [confirmed, pending, done] }),
      "2026-11",
    );

  test("each state, with its link and words", async () => {
    const view = await run();
    expect(cell(view, 0, 3)).toMatchObject({
      state: "booked",
      letter: "B",
      href: `/trips/${confirmed._id}`,
    });
    expect(cell(view, 0, 3).srLabel).toBe(
      "Tuesday 3 November: booked, guest Ravi",
    );
    expect(cell(view, 0, 10)).toMatchObject({
      state: "requested",
      letter: "R",
      href: `/trips/${pending._id}`,
    });
    expect(cell(view, 0, 10).srLabel).toContain("request awaiting your answer");
    expect(cell(view, 0, 12)).toMatchObject({
      state: "blocked",
      letter: "X",
      href: `/host/listings/${a._id}/calendar?month=2026-11`,
    });
    expect(cell(view, 0, 20)).toMatchObject({ state: "stayed", letter: "S" });
    expect(cell(view, 0, 5)).toMatchObject({ state: "free", day: 5 });
    expect(cell(view, 0, 5).href).toBeUndefined();
  });

  test("counts per listing and in total", async () => {
    const view = await run();
    expect(view.rows[0].counts).toEqual({
      requested: 1,
      booked: 2,
      stayed: 1,
      blocked: 1,
    });
    expect(view.totals).toEqual({
      requested: 1,
      booked: 2,
      stayed: 1,
      blocked: 1,
    });
  });

  test("a request whose hold ran out counts as a free night", async () => {
    const lapsed = night(
      a,
      "2026-11-10",
      { kind: "reservation", id: pending._id },
      { holdExpiresAt: new Date("2026-10-19T00:00:00Z") },
    );
    const view = await overview(
      deps({ listings: [a], nights: [lapsed], reservations: [pending] }),
      "2026-11",
    );
    expect(cell(view, 0, 10).state).toBe("free");
    expect(view.totals.requested).toBe(0);
  });

  test("a night whose reservation is not this host's (or is gone) is booked but has no link and no guest name", async () => {
    const stranger = new ObjectId();
    const view = await overview(
      deps({
        listings: [a],
        nights: [night(a, "2026-11-03", { kind: "reservation", id: stranger })],
        reservations: [],
      }),
      "2026-11",
    );
    expect(cell(view, 0, 3)).toMatchObject({ state: "booked" });
    expect(cell(view, 0, 3).href).toBeNull();
    expect(cell(view, 0, 3).srLabel).not.toContain("guest");
  });

  test("the reservation lookup is limited to this host", async () => {
    const dep = deps({ listings: [a], nights, reservations: [confirmed] });
    await overview(dep, "2026-11");
    expect(dep.calls.reservations[0].host).toBe(HOST);
    expect(dep.calls.reservations[0]._id.$in.map(String).sort()).toEqual(
      [String(confirmed._id), String(pending._id), String(done._id)].sort(),
    );
  });

  test("two listings do not share nights", async () => {
    const b = listing("Hill cabin");
    const view = await overview(
      deps({
        listings: [a, b],
        nights: [night(b, "2026-11-03", { kind: "block", id: new ObjectId() })],
      }),
      "2026-11",
    );
    expect(cell(view, 0, 3).state).toBe("free");
    expect(cell(view, 1, 3).state).toBe("blocked");
  });

  test("the legend names every state in words", async () => {
    const view = await run();
    expect(view.legend.map((l) => l.key)).toEqual([
      "requested",
      "booked",
      "stayed",
      "blocked",
    ]);
    for (const item of view.legend) expect(item.word.length).toBeGreaterThan(3);
  });
});
