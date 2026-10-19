// P07-T04: query parsing, stay rules and the availability payload (no database).
const mongoose = require("mongoose");
const {
  parseAvailabilityQuery,
  stayRulesFor,
  stayProblems,
  getAvailability,
  MAX_RANGE_NIGHTS,
} = require("../../src/services/availability");
const { ValidationError } = require("../../src/utils/errors");

const day = (text) => new Date(`${text}T00:00:00Z`);
const NOW = new Date("2026-10-20T06:00:00Z"); // 11:30 in India: today is 2026-10-20
const listing = () => ({ _id: new mongoose.Types.ObjectId(), minNights: 2, maxNights: 14 });

describe("parseAvailabilityQuery", () => {
  test("accepts a real range", () => {
    const { from, to } = parseAvailabilityQuery({ from: "2026-11-01", to: "2026-12-01" });
    expect(from).toEqual(day("2026-11-01"));
    expect(to).toEqual(day("2026-12-01"));
  });

  test.each([
    [{}, "from"],
    [{ from: "2026-11-01" }, "to"],
    [{ from: "2026-11-01", to: "" }, "to"],
    [{ from: "2026-02-30", to: "2026-03-05" }, "from"],
    [{ from: "2026-1-5", to: "2026-03-05" }, "from"],
    [{ from: "2026-11-01T00:00:00Z", to: "2026-12-01" }, "from"],
    [{ from: ["2026-11-01", "2026-11-02"], to: "2026-12-01" }, "from"],
    [{ from: { a: "2026-11-01" }, to: "2026-12-01" }, "from"],
    [{ from: "2026-11-01", to: "next week" }, "to"],
  ])("rejects %j", (query, field) => {
    expect(() => parseAvailabilityQuery(query)).toThrow(ValidationError);
    expect(() => parseAvailabilityQuery(query)).toThrow(new RegExp(field));
  });

  test("to must be after from and the range is capped", () => {
    expect(() => parseAvailabilityQuery({ from: "2026-11-05", to: "2026-11-05" })).toThrow(ValidationError);
    expect(() => parseAvailabilityQuery({ from: "2026-11-05", to: "2026-11-01" })).toThrow(ValidationError);
    expect(() => parseAvailabilityQuery({ from: "2026-01-01", to: "2027-01-01" })).not.toThrow();
    expect(MAX_RANGE_NIGHTS).toBe(400);
    expect(() => parseAvailabilityQuery({ from: "2026-01-01", to: "2027-03-01" })).toThrow(ValidationError);
  });
});

describe("stayRulesFor", () => {
  const today = day("2026-10-20");

  test("uses the host's minimum and maximum and the booking window", () => {
    expect(stayRulesFor({ minNights: 2, maxNights: 14 }, { today })).toEqual({
      today: "2026-10-20",
      earliestCheckIn: "2026-10-20",
      latestCheckIn: "2027-10-20",
      minNights: 2,
      maxNights: 14,
    });
  });

  test("a host maximum above 90 nights is capped at 90; missing values use defaults", () => {
    expect(stayRulesFor({ minNights: 1, maxNights: 365 }, { today }).maxNights).toBe(90);
    const rules = stayRulesFor({}, { today });
    expect(rules.minNights).toBe(1);
    expect(rules.maxNights).toBe(90);
  });

  test("a minimum above the cap is pulled down so a stay is always possible", () => {
    const rules = stayRulesFor({ minNights: 200, maxNights: 365 }, { today });
    expect(rules.minNights).toBeLessThanOrEqual(rules.maxNights);
  });
});

describe("stayProblems", () => {
  const rules = stayRulesFor({ minNights: 2, maxNights: 5 }, { today: day("2026-10-20") });
  const problems = (checkIn, checkOut, unavailable = []) =>
    stayProblems({ checkIn: day(checkIn), checkOut: day(checkOut), rules, unavailable: unavailable.map(day) });

  test("a good stay has no problems", () => {
    expect(problems("2026-11-01", "2026-11-04")).toEqual([]);
  });

  test("check-out on a taken night is fine (it is not slept in)", () => {
    expect(problems("2026-11-01", "2026-11-04", ["2026-11-04"])).toEqual([]);
  });

  test("names each broken rule", () => {
    expect(problems("2026-11-04", "2026-11-04")[0]).toMatch(/after check-in/);
    expect(problems("2026-10-19", "2026-10-22").join(" ")).toMatch(/past/);
    expect(problems("2027-10-21", "2027-10-24").join(" ")).toMatch(/365 days/);
    expect(problems("2026-11-01", "2026-11-02").join(" ")).toMatch(/minimum stay is 2 nights/);
    expect(problems("2026-11-01", "2026-11-09").join(" ")).toMatch(/maximum stay is 5 nights/);
    expect(problems("2026-11-01", "2026-11-04", ["2026-11-02"]).join(" ")).toMatch(/2026-11-02/);
  });
});

describe("getAvailability", () => {
  function fakeLedger(dates = []) {
    return { unavailableDates: jest.fn(async () => dates.map(day)) };
  }

  test("returns date strings and the rules, nothing else", async () => {
    const l = listing();
    const ledgerService = fakeLedger(["2026-11-03", "2026-11-04"]);
    const payload = await getAvailability(l, { from: "2026-11-01", to: "2026-12-01" }, { now: NOW, ledgerService });
    expect(payload).toEqual({
      from: "2026-11-01",
      to: "2026-12-01",
      unavailable: ["2026-11-03", "2026-11-04"],
      rules: expect.objectContaining({ today: "2026-10-20", minNights: 2, maxNights: 14 }),
    });
    expect(ledgerService.unavailableDates).toHaveBeenCalledWith(l._id, day("2026-11-01"), day("2026-12-01"), { now: NOW });
  });

  test("past nights are not asked for: the query starts today", async () => {
    const ledgerService = fakeLedger();
    await getAvailability(listing(), { from: "2026-10-01", to: "2026-11-01" }, { now: NOW, ledgerService });
    expect(ledgerService.unavailableDates.mock.calls[0][1]).toEqual(day("2026-10-20"));
  });

  test("a range wholly in the past asks nothing and returns no dates", async () => {
    const ledgerService = fakeLedger(["2026-09-02"]);
    const payload = await getAvailability(listing(), { from: "2026-09-01", to: "2026-10-01" }, { now: NOW, ledgerService });
    expect(ledgerService.unavailableDates).not.toHaveBeenCalled();
    expect(payload.unavailable).toEqual([]);
  });

  test("a range beyond the last possible stay is cut off; fully beyond asks nothing", async () => {
    const ledgerService = fakeLedger();
    // latest check-in 2027-10-20 + 90 nights = 2028-01-18
    await getAvailability(listing(), { from: "2027-12-01", to: "2028-02-01" }, { now: NOW, ledgerService });
    expect(ledgerService.unavailableDates.mock.calls[0][2]).toEqual(day("2028-01-18"));
    ledgerService.unavailableDates.mockClear();
    await getAvailability(listing(), { from: "2028-03-01", to: "2028-04-01" }, { now: NOW, ledgerService });
    expect(ledgerService.unavailableDates).not.toHaveBeenCalled();
  });

  test("bad input never reaches the ledger", async () => {
    const ledgerService = fakeLedger();
    await expect(getAvailability(listing(), { from: "x", to: "y" }, { now: NOW, ledgerService })).rejects.toThrow(ValidationError);
    expect(ledgerService.unavailableDates).not.toHaveBeenCalled();
  });
});
