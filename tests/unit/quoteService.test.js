// P08-T02: getQuote = rules + ledger + the pricing service's own output.
const { getQuote } = require("../../src/services/quoteService");
const pricing = require("../../src/services/pricing");
const { parseDateOnly } = require("../../src/utils/dates");
const {
  ValidationError,
  QuoteRefusedError,
} = require("../../src/utils/errors");

const d = (s) => parseDateOnly(s);
const NOW = new Date("2026-10-20T06:00:00Z"); // 11:30 on 20 Oct in Kolkata
const listing = (extra = {}) => ({
  _id: "64b0f0f0f0f0f0f0f0f0aaaa",
  timezone: "Asia/Kolkata",
  checkInTime: "14:00",
  minNights: 1,
  maxNights: 14,
  capacity: { guests: 4 },
  pricing: {
    nightlyMinor: 250000,
    weekendNightlyMinor: 300000,
    cleaningFeeMinor: 50000,
    currency: "INR",
  },
  ...extra,
});
const query = (over = {}) => ({
  in: "2026-11-02",
  out: "2026-11-05",
  guests: "2",
  ...over,
});
const ledger = (taken = []) => ({
  unavailableDates: jest.fn(async () => taken),
});

describe("getQuote", () => {
  test("a bookable stay returns exactly the pricing service's quote", async () => {
    const l = listing();
    const fake = ledger();
    const payload = await getQuote(l, query(), {
      now: NOW,
      ledgerService: fake,
    });
    const expected = pricing.quote({
      listing: l,
      checkIn: d("2026-11-02"),
      checkOut: d("2026-11-05"),
      guests: 2,
    });
    expect(payload).toEqual({
      in: "2026-11-02",
      out: "2026-11-05",
      guests: 2,
      bookable: true,
      problems: [],
      quote: expected,
      expectedTotalMinor: expected.totalMinor,
    });
    expect(Number.isInteger(payload.expectedTotalMinor)).toBe(true);
    expect(fake.unavailableDates).toHaveBeenCalledTimes(1);
  });

  test("taken nights: no price, one reason with the dates only", async () => {
    const payload = await getQuote(listing(), query(), {
      now: NOW,
      ledgerService: ledger([d("2026-11-03")]),
    });
    expect(payload.bookable).toBe(false);
    expect(payload.quote).toBeNull();
    expect(payload.expectedTotalMinor).toBeNull();
    expect(payload.problems).toEqual([
      {
        code: "nights_unavailable",
        message: "These nights are not available: 2026-11-03.",
      },
    ]);
  });

  test("a rule problem returns its reason and never reaches the ledger or pricing", async () => {
    const fake = ledger();
    const pricingService = { quote: jest.fn() };
    const payload = await getQuote(
      listing({ minNights: 3 }),
      query({ out: "2026-11-03" }),
      { now: NOW, ledgerService: fake, pricingService },
    );
    expect(payload.bookable).toBe(false);
    expect(payload.problems.map((p) => p.code)).toEqual(["below_min_nights"]);
    expect(fake.unavailableDates).not.toHaveBeenCalled();
    expect(pricingService.quote).not.toHaveBeenCalled();
  });

  test.each([
    ["more people than the place sleeps", { guests: "9" }, {}, "over_capacity"],
    ["too long a stay", { out: "2026-12-30" }, {}, "above_max_nights"],
    [
      "past check-in",
      { in: "2026-10-19", out: "2026-10-22" },
      {},
      "check_in_past",
    ],
    [
      "not enough notice",
      { in: "2026-10-21", out: "2026-10-23" },
      { advanceNoticeHours: 48 },
      "advance_notice",
    ],
    [
      "after the same-day cut-off",
      { in: "2026-10-20", out: "2026-10-22" },
      { sameDayCutoffTime: "11:00" },
      "same_day_cutoff",
    ],
  ])("%s", async (_name, over, extra, code) => {
    const payload = await getQuote(listing(extra), query(over), {
      now: NOW,
      ledgerService: ledger(),
    });
    expect(payload.problems.map((p) => p.code)).toContain(code);
    expect(payload.quote).toBeNull();
  });

  test("bad input is a ValidationError with fields", async () => {
    await expect(
      getQuote(listing(), { in: "x" }, { now: NOW, ledgerService: ledger() }),
    ).rejects.toMatchObject({
      statusCode: 400,
      fields: expect.objectContaining({
        in: expect.any(String),
        out: expect.any(String),
        guests: expect.any(String),
      }),
    });
    await expect(
      getQuote(listing(), { in: "x" }, { now: NOW, ledgerService: ledger() }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("a listing without a valid price is refused by pricing (422)", async () => {
    await expect(
      getQuote(listing({ pricing: {} }), query(), {
        now: NOW,
        ledgerService: ledger(),
      }),
    ).rejects.toBeInstanceOf(QuoteRefusedError);
  });
});
