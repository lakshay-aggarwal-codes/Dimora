// Host availability calendar logic (P07-T03) against the real ledger service
// on in-memory fakes (no mongod). The unique index and true concurrency are
// covered by tests/integration/availability.db.test.js.
const { createLedgerService } = require("../../src/services/ledger");
const {
  createAvailabilityService,
  parseRange,
  cleanNote,
} = require("../../src/services/availability");
const { ConflictError, ValidationError } = require("../../src/utils/errors");
const { parseDateOnly, addDays, formatDateOnly } = require("../../src/utils/dates");
const { FakeStayNight, fakeId } = require("../helpers/fakeStayNight");
const { FakeAvailabilityBlock } = require("../helpers/fakeAvailabilityBlock");

const d = (s) => parseDateOnly(s);
const iso = (date) => formatDateOnly(date);
const isValidId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/.test(v);
// 11:30 in Kolkata, so "today" is 2026-10-20 there and in New York.
const NOW = new Date("2026-10-20T06:00:00Z");
const TODAY = d("2026-10-20");

let nights; // FakeStayNight
let blocks; // FakeAvailabilityBlock
let ledger;
let service;
let listing;

beforeEach(() => {
  nights = new FakeStayNight();
  blocks = new FakeAvailabilityBlock();
  ledger = createLedgerService({ model: nights, newId: fakeId, isValidId });
  service = createAvailabilityService({ ledger, blockModel: blocks, newId: fakeId });
  listing = { _id: fakeId(), timezone: "Asia/Kolkata", status: "published" };
});

const stay = () => ({ kind: "reservation", id: fakeId() });
const days = (start, count) =>
  Array.from({ length: count }, (_, i) => addDays(d(start), i));
const rowsOf = (kind) => nights.rows.filter((r) => r.source.kind === kind);
const block = (input) => service.blockDates(listing, input, { now: NOW });
const unblock = (input) => service.unblockDates(listing, input, { now: NOW });

describe("parseRange", () => {
  const ok = (input) => parseRange(input, { today: TODAY, withNote: true });

  test("first and last night are both included: 'to' is the day after", () => {
    const r = ok({ from: "2026-11-05", through: "2026-11-07" });
    expect(iso(r.from)).toBe("2026-11-05");
    expect(iso(r.through)).toBe("2026-11-07");
    expect(iso(r.to)).toBe("2026-11-08");
    expect(r.nights).toBe(3);
  });

  test("one night: first and last are the same date", () => {
    expect(ok({ from: "2026-11-05", through: "2026-11-05" }).nights).toBe(1);
  });

  test("today can be blocked; yesterday cannot", () => {
    expect(ok({ from: "2026-10-20", through: "2026-10-20" }).nights).toBe(1);
    expect(() => ok({ from: "2026-10-19", through: "2026-10-21" })).toThrow(
      /already passed/,
    );
  });

  test("the last night can be at most a year ahead (366 nights at most)", () => {
    const last = iso(addDays(TODAY, 365));
    const r = ok({ from: "2026-10-20", through: last });
    expect(r.nights).toBe(366);
    expect(() =>
      ok({ from: "2026-10-20", through: iso(addDays(TODAY, 366)) }),
    ).toThrow(/up to a year ahead/);
  });

  test.each([
    ["not a real date", { from: "2026-02-30", through: "2026-03-02" }, /first night/],
    ["no zero padding", { from: "2026-1-5", through: "2026-11-07" }, /first night/],
    ["a time is attached", { from: "2026-11-05T00:00:00Z", through: "2026-11-07" }, /first night/],
    ["missing first night", { through: "2026-11-07" }, /first night/],
    ["bad last night", { from: "2026-11-05", through: "soon" }, /last night as a valid/],
    ["missing last night", { from: "2026-11-05" }, /last night as a valid/],
    ["an array", { from: ["2026-11-05"], through: "2026-11-07" }, /first night/],
    ["an object", { from: { $gt: "" }, through: "2026-11-07" }, /first night/],
  ])("refuses %s", (_label, input, message) => {
    expect(() => ok(input)).toThrow(ValidationError);
    expect(() => ok(input)).toThrow(message);
  });

  test("the last night cannot be before the first", () => {
    expect(() => ok({ from: "2026-11-07", through: "2026-11-05" })).toThrow(
      /cannot be before the first night/,
    );
  });

  test("a missing body is a validation error, not a crash", () => {
    expect(() => ok(undefined)).toThrow(ValidationError);
    expect(() => ok(null)).toThrow(ValidationError);
  });
});

describe("cleanNote", () => {
  test("trims, drops control characters and keeps it on one line", () => {
    expect(cleanNote("  family   visit \n\t ")).toBe("family visit");
    expect(cleanNote("a\u0000b\u0007c")).toBe("a b c");
  });
  test("empty and missing are an empty note", () => {
    expect(cleanNote(undefined)).toBe("");
    expect(cleanNote(null)).toBe("");
    expect(cleanNote("   ")).toBe("");
  });
  test("200 characters are fine, 201 are not", () => {
    expect(cleanNote("x".repeat(200))).toHaveLength(200);
    expect(() => cleanNote("x".repeat(201))).toThrow(/at most 200/);
  });
  test("only text is accepted", () => {
    expect(() => cleanNote(["a"])).toThrow(ValidationError);
    expect(() => cleanNote({ a: 1 })).toThrow(ValidationError);
    expect(() => cleanNote(5)).toThrow(ValidationError);
  });
  test("markup is kept as text (the view escapes it)", () => {
    expect(cleanNote("<b>hi</b>")).toBe("<b>hi</b>");
  });
});

describe("blockDates", () => {
  test("puts one ledger row per night, owned by the block, with no hold", async () => {
    const result = await block({
      from: "2026-11-05",
      through: "2026-11-07",
      note: " Family visit ",
    });
    expect(result).toMatchObject({ changed: true, blocked: 3, alreadyBlocked: 0 });
    expect(nights.rows).toHaveLength(3);
    expect(nights.rows.map((r) => iso(r.date))).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    const id = nights.rows[0].source.id;
    expect(nights.rows.every((r) => r.source.kind === "block" && r.source.id === id)).toBe(true);
    expect(nights.rows.every((r) => r.holdExpiresAt === undefined)).toBe(true);
    expect(nights.rows.every((r) => r.listing === listing._id)).toBe(true);

    expect(blocks.docs).toHaveLength(1);
    expect(blocks.docs[0]).toMatchObject({ _id: id, listing: listing._id, note: "Family visit" });
    expect(iso(blocks.docs[0].from)).toBe("2026-11-05");
    expect(iso(blocks.docs[0].to)).toBe("2026-11-08");
  });

  test("records who blocked", async () => {
    const userId = fakeId();
    await service.blockDates(listing, { from: "2026-11-05", through: "2026-11-05" }, { now: NOW, userId });
    expect(blocks.docs[0].createdBy).toBe(userId);
  });

  test("a night a guest has reserved cannot be blocked: nothing at all is blocked", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-06", 2), stay());
    await expect(block({ from: "2026-11-04", through: "2026-11-09" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(block({ from: "2026-11-04", through: "2026-11-09" })).rejects.toMatchObject({
      statusCode: 409,
      code: "nights_reserved",
    });
    expect(rowsOf("block")).toHaveLength(0);
    expect(rowsOf("reservation")).toHaveLength(2);
    expect(blocks.docs).toHaveLength(0);
  });

  test("the message names the nights that are held", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-06", 1), stay());
    await expect(block({ from: "2026-11-05", through: "2026-11-07" })).rejects.toThrow(
      /6 Nov 2026/,
    );
  });

  test("a pending request's live hold also stops a block", async () => {
    const hold = new Date("2026-10-21T06:00:00Z");
    await ledger.reserveNights(listing._id, days("2026-11-06", 1), stay(), hold, { now: NOW });
    await expect(block({ from: "2026-11-05", through: "2026-11-07" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(rowsOf("block")).toHaveLength(0);
  });

  test("an expired hold no longer stops a block (it is taken over)", async () => {
    await ledger.reserveNights(
      listing._id,
      days("2026-11-06", 1),
      stay(),
      new Date("2026-10-20T07:00:00Z"),
      { now: NOW },
    );
    const later = new Date("2026-10-20T09:00:00Z");
    const result = await service.blockDates(
      listing,
      { from: "2026-11-05", through: "2026-11-07" },
      { now: later },
    );
    expect(result.blocked).toBe(3);
    expect(rowsOf("reservation")).toHaveLength(0);
    expect(rowsOf("block")).toHaveLength(3);
  });

  test("nights the host already blocked are skipped and counted", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    const result = await block({ from: "2026-11-06", through: "2026-11-08", note: "more" });
    expect(result).toMatchObject({ changed: true, blocked: 2, alreadyBlocked: 1 });
    expect(rowsOf("block")).toHaveLength(4);
    expect(blocks.docs).toHaveLength(2);
  });

  test("blocking only already-blocked nights changes nothing", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    const result = await block({ from: "2026-11-05", through: "2026-11-06" });
    expect(result).toMatchObject({ changed: false, blocked: 0, alreadyBlocked: 2 });
    expect(blocks.docs).toHaveLength(1);
    expect(rowsOf("block")).toHaveLength(2);
  });

  test("a blocked night rejects a booking", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    await expect(
      ledger.reserveNights(listing._id, days("2026-11-06", 3), stay()),
    ).rejects.toMatchObject({ statusCode: 409, code: "nights_unavailable" });
    expect(rowsOf("reservation")).toHaveLength(0);
  });

  test("a night free before and after the block can still be booked", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    await ledger.reserveNights(listing._id, days("2026-11-07", 2), stay());
    await ledger.reserveNights(listing._id, days("2026-11-03", 2), stay());
    expect(rowsOf("reservation")).toHaveLength(4);
  });

  test("a guest who wins the race gets the night and the block fails cleanly", async () => {
    // The pre-check sees nothing, then a guest takes a night before our insert.
    const racy = {
      ...ledger,
      nightsInRange: async () => [],
    };
    const racing = createAvailabilityService({ ledger: racy, blockModel: blocks, newId: fakeId });
    await ledger.reserveNights(listing._id, days("2026-11-06", 1), stay());
    await expect(
      racing.blockDates(listing, { from: "2026-11-05", through: "2026-11-07" }, { now: NOW }),
    ).rejects.toMatchObject({ statusCode: 409, code: "nights_reserved" });
    expect(rowsOf("block")).toHaveLength(0); // the partial insert was rolled back
    expect(rowsOf("reservation")).toHaveLength(1);
    expect(blocks.docs).toHaveLength(0);
  });

  test("if the block record cannot be saved, the nights are released again", async () => {
    blocks.createFailure = new Error("db down");
    await expect(block({ from: "2026-11-05", through: "2026-11-07" })).rejects.toThrow("db down");
    expect(nights.rows).toHaveLength(0);
  });

  test("a bad note or bad dates change nothing", async () => {
    await expect(
      block({ from: "2026-11-05", through: "2026-11-07", note: "x".repeat(201) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(block({ from: "nope", through: "2026-11-07" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(nights.rows).toHaveLength(0);
    expect(blocks.docs).toHaveLength(0);
  });

  test("a block and a booking for the same nights, started together: exactly one wins", async () => {
    const outcomes = await Promise.allSettled([
      block({ from: "2026-11-05", through: "2026-11-06" }),
      ledger.reserveNights(listing._id, days("2026-11-05", 2), stay()),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(nights.rows).toHaveLength(2);
    expect(new Set(nights.rows.map((r) => r.source.id)).size).toBe(1);
  });

  test("uses the listing's own 'today' (a block for the Kolkata date is in the past in New York)", async () => {
    // 2026-10-20T20:00Z: Kolkata is already 21 Oct, New York is still 20 Oct.
    const late = new Date("2026-10-20T20:00:00Z");
    await expect(
      service.blockDates(listing, { from: "2026-10-20", through: "2026-10-21" }, { now: late }),
    ).rejects.toThrow(/already passed/);
    const newYork = { ...listing, timezone: "America/New_York" };
    const result = await service.blockDates(
      newYork,
      { from: "2026-10-20", through: "2026-10-21" },
      { now: late },
    );
    expect(result.blocked).toBe(2);
  });
});

describe("unblockDates", () => {
  test("frees the blocked nights and drops the emptied block record", async () => {
    await block({ from: "2026-11-05", through: "2026-11-07" });
    const result = await unblock({ from: "2026-11-05", through: "2026-11-07" });
    expect(result.released).toBe(3);
    expect(nights.rows).toHaveLength(0);
    expect(blocks.docs).toHaveLength(0);
  });

  test("removes only block rows: reservations in the same range stay", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    await ledger.reserveNights(listing._id, days("2026-11-07", 2), stay());
    const result = await unblock({ from: "2026-11-01", through: "2026-11-30" });
    expect(result.released).toBe(2);
    expect(rowsOf("block")).toHaveLength(0);
    expect(rowsOf("reservation")).toHaveLength(2);
  });

  test("unblocking only reserved nights releases nothing", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-07", 2), stay());
    const result = await unblock({ from: "2026-11-07", through: "2026-11-08" });
    expect(result.released).toBe(0);
    expect(rowsOf("reservation")).toHaveLength(2);
  });

  test("freeing part of a block keeps the rest and its record", async () => {
    await block({ from: "2026-11-05", through: "2026-11-09", note: "trip" });
    const result = await unblock({ from: "2026-11-06", through: "2026-11-07" });
    expect(result.released).toBe(2);
    expect(rowsOf("block").map((r) => iso(r.date))).toEqual([
      "2026-11-05",
      "2026-11-08",
      "2026-11-09",
    ]);
    expect(blocks.docs).toHaveLength(1);
  });

  test("once the nights are free a guest can book them", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    await unblock({ from: "2026-11-05", through: "2026-11-06" });
    await ledger.reserveNights(listing._id, days("2026-11-05", 2), stay());
    expect(rowsOf("reservation")).toHaveLength(2);
  });

  test("doing it twice is harmless", async () => {
    await block({ from: "2026-11-05", through: "2026-11-06" });
    await unblock({ from: "2026-11-05", through: "2026-11-06" });
    const again = await unblock({ from: "2026-11-05", through: "2026-11-06" });
    expect(again.released).toBe(0);
  });

  test("another listing's blocks are untouched", async () => {
    const other = { _id: fakeId(), timezone: "Asia/Kolkata", status: "published" };
    await service.blockDates(other, { from: "2026-11-05", through: "2026-11-06" }, { now: NOW });
    const result = await unblock({ from: "2026-11-01", through: "2026-11-30" });
    expect(result.released).toBe(0);
    expect(nights.rows).toHaveLength(2);
    expect(blocks.docs).toHaveLength(1);
  });

  test("past dates and bad dates are refused", async () => {
    await expect(unblock({ from: "2026-10-01", through: "2026-10-05" })).rejects.toThrow(
      /already passed/,
    );
    await expect(unblock({ from: "", through: "2026-10-25" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("listBlocks", () => {
  test("one entry per stretch, soonest first, with its note", async () => {
    await block({ from: "2026-12-10", through: "2026-12-12", note: "Later" });
    await block({ from: "2026-11-05", through: "2026-11-05", note: "Sooner" });
    const { runs, truncated } = await service.listBlocks(listing, { now: NOW });
    expect(truncated).toBe(false);
    expect(runs).toEqual([
      expect.objectContaining({ fromIso: "2026-11-05", throughIso: "2026-11-05", nights: 1, note: "Sooner", nightsLabel: "1 night" }),
      expect.objectContaining({ fromIso: "2026-12-10", throughIso: "2026-12-12", nights: 3, note: "Later", nightsLabel: "3 nights" }),
    ]);
    expect(runs[0].fromLabel).toBe("5 Nov 2026");
  });

  test("after a partial unblock the block shows as two stretches", async () => {
    await block({ from: "2026-11-05", through: "2026-11-09" });
    await unblock({ from: "2026-11-07", through: "2026-11-07" });
    const { runs } = await service.listBlocks(listing, { now: NOW });
    expect(runs.map((r) => [r.fromIso, r.throughIso])).toEqual([
      ["2026-11-05", "2026-11-06"],
      ["2026-11-08", "2026-11-09"],
    ]);
  });

  test("reservations, other listings and nights already past are not listed", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-05", 2), stay());
    await ledger.reserveNights(fakeId(), days("2026-11-05", 2), { kind: "block", id: fakeId() });
    await ledger.reserveNights(listing._id, days("2026-10-10", 2), { kind: "block", id: fakeId() });
    const { runs } = await service.listBlocks(listing, { now: NOW });
    expect(runs).toEqual([]);
  });

  test("a block with no record (orphan) is still listed, with an empty note", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-05", 2), { kind: "block", id: fakeId() });
    const { runs } = await service.listBlocks(listing, { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].note).toBe("");
  });

  test("at most 100 stretches are listed and the rest is reported", async () => {
    for (let i = 0; i < 101; i += 1) {
      await ledger.reserveNights(listing._id, [addDays(d("2026-11-01"), i * 2)], {
        kind: "block",
        id: fakeId(),
      });
    }
    const { runs, truncated } = await service.listBlocks(listing, { now: NOW });
    expect(runs).toHaveLength(100);
    expect(truncated).toBe(true);
  });
});

describe("monthView", () => {
  test("a month grid: Monday first, leading and trailing blanks, 7 cells per week", async () => {
    const view = await service.monthView(listing, "2026-11", { now: NOW });
    expect(view.monthKey).toBe("2026-11");
    expect(view.label).toBe("November 2026");
    expect(view.weekdays.map((w) => w.short)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    // 1 Nov 2026 is a Sunday: six blanks, 30 days, then padding to 42 cells.
    expect(view.weeks).toHaveLength(6);
    expect(view.weeks.every((week) => week.length === 7)).toBe(true);
    expect(view.weeks[0].slice(0, 6).every((cell) => cell === null)).toBe(true);
    expect(view.weeks[0][6]).toMatchObject({ day: 1, iso: "2026-11-01" });
    const real = view.weeks.flat().filter(Boolean);
    expect(real).toHaveLength(30);
    expect(real[29]).toMatchObject({ day: 30, iso: "2026-11-30" });
  });

  test("a month that starts on a Monday has no leading blanks", async () => {
    const view = await service.monthView(listing, "2026-12", { now: NOW }); // 1 Dec 2026 = Tuesday
    expect(view.weeks[0][0]).toBeNull();
    const feb = await service.monthView(listing, "2027-02", { now: NOW }); // 1 Feb 2027 = Monday
    expect(feb.weeks[0][0]).toMatchObject({ day: 1 });
    expect(feb.weeks).toHaveLength(4); // 28 days, exactly four weeks
  });

  test("blocked, reserved, requested and free nights are told apart", async () => {
    await block({ from: "2026-11-03", through: "2026-11-04" });
    await ledger.reserveNights(listing._id, days("2026-11-10", 2), stay());
    await ledger.reserveNights(listing._id, days("2026-11-20", 1), stay(), new Date("2026-10-21T06:00:00Z"), {
      now: NOW,
    });
    const view = await service.monthView(listing, "2026-11", { now: NOW });
    const byIso = Object.fromEntries(view.weeks.flat().filter(Boolean).map((c) => [c.iso, c]));
    expect(byIso["2026-11-03"]).toMatchObject({ state: "blocked", stateLabel: "Blocked" });
    expect(byIso["2026-11-10"]).toMatchObject({ state: "reserved", stateLabel: "Reserved" });
    expect(byIso["2026-11-20"]).toMatchObject({ state: "requested", stateLabel: "Request" });
    expect(byIso["2026-11-05"]).toMatchObject({ state: "free", stateLabel: "" });
    expect(view.counts).toEqual({ blocked: 2, reserved: 2, requested: 1 });
    expect(byIso["2026-11-03"].srLabel).toBe("Tuesday 3 November 2026: blocked by you");
    expect(byIso["2026-11-05"].srLabel).toContain("available");
  });

  test("an expired hold shows as free", async () => {
    await ledger.reserveNights(listing._id, days("2026-11-20", 1), stay(), new Date("2026-10-20T07:00:00Z"), {
      now: NOW,
    });
    const view = await service.monthView(listing, "2026-11", {
      now: new Date("2026-10-20T09:00:00Z"),
    });
    const cell = view.weeks.flat().find((c) => c && c.iso === "2026-11-20");
    expect(cell.state).toBe("free");
  });

  test("today and past days are marked (in the listing's time zone)", async () => {
    const view = await service.monthView(listing, "2026-10", { now: NOW });
    const byIso = Object.fromEntries(view.weeks.flat().filter(Boolean).map((c) => [c.iso, c]));
    expect(byIso["2026-10-20"]).toMatchObject({ today: true, past: false });
    expect(byIso["2026-10-20"].srLabel).toContain("today");
    expect(byIso["2026-10-19"]).toMatchObject({ today: false, past: true });
    expect(byIso["2026-10-21"]).toMatchObject({ today: false, past: false });
    expect(view.todayIso).toBe("2026-10-20");

    const late = new Date("2026-10-20T20:00:00Z"); // 21 Oct in Kolkata, 20 Oct in New York
    const kolkata = await service.monthView(listing, "2026-10", { now: late });
    expect(kolkata.todayIso).toBe("2026-10-21");
    const newYork = await service.monthView({ ...listing, timezone: "America/New_York" }, "2026-10", { now: late });
    expect(newYork.todayIso).toBe("2026-10-20");
  });

  test("past nights keep showing what they were", async () => {
    await ledger.reserveNights(listing._id, days("2026-10-05", 2), stay());
    const view = await service.monthView(listing, "2026-10", { now: NOW });
    const cell = view.weeks.flat().find((c) => c && c.iso === "2026-10-05");
    expect(cell).toMatchObject({ state: "reserved", past: true });
  });

  test("only this listing's nights appear", async () => {
    await ledger.reserveNights(fakeId(), days("2026-11-10", 2), stay());
    const view = await service.monthView(listing, "2026-11", { now: NOW });
    expect(view.counts).toEqual({ blocked: 0, reserved: 0, requested: 0 });
  });

  test("month navigation: a year back, to the end of the booking horizon", async () => {
    const now = await service.monthView(listing, undefined, { now: NOW });
    expect(now.monthKey).toBe("2026-10");
    expect(now.prevKey).toBe("2026-09");
    expect(now.nextKey).toBe("2026-11");

    const first = await service.monthView(listing, "2025-10", { now: NOW });
    expect(first.prevKey).toBeNull();
    expect(first.nextKey).toBe("2025-11");

    const last = await service.monthView(listing, "2027-10", { now: NOW }); // 20 Oct 2027 = today + 365
    expect(last.nextKey).toBeNull();
    expect(last.prevKey).toBe("2027-09");
  });

  test("a month outside the range is clamped; a bad value shows this month", async () => {
    expect((await service.monthView(listing, "2020-01", { now: NOW })).monthKey).toBe("2025-10");
    expect((await service.monthView(listing, "2035-05", { now: NOW })).monthKey).toBe("2027-10");
    for (const bad of ["abc", "2026-13", "2026-1", "", ["2026-11"], { a: 1 }, null, 7]) {
      expect((await service.monthView(listing, bad, { now: NOW })).monthKey).toBe("2026-10");
    }
  });

  test("the view carries no ledger ids or guest data", async () => {
    const source = stay();
    await ledger.reserveNights(listing._id, days("2026-11-10", 2), source);
    const view = await service.monthView(listing, "2026-11", { now: NOW });
    expect(JSON.stringify(view)).not.toContain(source.id);
  });

  test("the form limits are today and the last night that can be changed", async () => {
    const view = await service.monthView(listing, "2026-11", { now: NOW });
    expect(view.todayIso).toBe("2026-10-20");
    expect(view.latestIso).toBe("2027-10-20");
  });
});
