// P15-T04: the nearest free stays of the same length. Fake ledger (a set of
// taken nights), the real rules and the real pricing service. The property test
// compares the service with a brute-force oracle over many random calendars.
const { suggestAlternatives } = require("../../src/services/flexibleDates");
const { getQuote } = require("../../src/services/quoteService");
const { bookingProblems } = require("../../src/services/bookingRules");
const pricing = require("../../src/services/pricing");
const {
  addDays,
  formatDateOnly,
  parseDateOnly,
  nightsBetween,
  todayIn,
} = require("../../src/utils/dates");

const NOW = new Date("2026-10-20T06:00:00Z"); // 11:30 on 20 Oct in Kolkata
const TODAY = todayIn("Asia/Kolkata", NOW);
const d = (s) => parseDateOnly(s);
const day = (n) => addDays(TODAY, n); // n days from "today"

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

/** A ledger over a set of taken nights (ms since epoch). Implements what the service uses. */
function fakeLedger(taken = new Set()) {
  return {
    taken,
    availableRanges: jest.fn(async (id, from, to) => {
      const ranges = [];
      let start = null;
      const span = nightsBetween(from, to);
      for (let i = 0; i < span; i += 1) {
        const date = addDays(from, i);
        if (taken.has(date.getTime())) {
          if (start)
            ranges.push({
              from: start,
              to: date,
              nights: nightsBetween(start, date),
            });
          start = null;
        } else if (!start) start = date;
      }
      if (start)
        ranges.push({ from: start, to, nights: nightsBetween(start, to) });
      return ranges;
    }),
    unavailableDates: jest.fn(async (id, from, to) => {
      const out = [];
      for (let i = 0; i < nightsBetween(from, to); i += 1) {
        const date = addDays(from, i);
        if (taken.has(date.getTime())) out.push(date);
      }
      return out;
    }),
  };
}
const takeNights = (ledger, from, n) => {
  for (let i = 0; i < n; i += 1) ledger.taken.add(addDays(from, i).getTime());
};
const stay = (inDay, nights, guests = 2) => ({
  checkIn: day(inDay),
  checkOut: day(inDay + nights),
  guests,
});
const run = (l, request, ledger, over = {}) =>
  suggestAlternatives(l, request, {
    now: NOW,
    ledgerService: ledger,
    pricingService: pricing,
    ...over,
  });
const shape = (result) => result.windows.map((w) => [w.in, w.out, w.shiftDays]);

describe("suggestAlternatives", () => {
  test("nearest stays of the same length first, on both sides, as different stays", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3); // the asked-for stay is taken: nights 20, 21, 22
    const result = await run(listing(), stay(20, 3), ledger);
    // free all around: 3 days before and 3 days after are the nearest non-overlapping starts
    expect(shape(result)).toEqual([
      [formatDateOnly(day(17)), formatDateOnly(day(20)), -3],
      [formatDateOnly(day(23)), formatDateOnly(day(26)), 3],
      [formatDateOnly(day(14)), formatDateOnly(day(17)), -6],
    ]);
    expect(result.radiusDays).toBe(14);
    for (const w of result.windows) expect(w.nights).toBe(3);
  });

  test("each window is priced by the pricing service exactly as the quote would be", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3);
    const l = listing();
    const { windows } = await run(l, stay(20, 3), ledger);
    for (const w of windows) {
      const expected = pricing.quote({
        listing: l,
        checkIn: d(w.in),
        checkOut: d(w.out),
        guests: 2,
      });
      expect(w.quote).toEqual(expected);
      const viaQuote = await getQuote(
        l,
        { in: w.in, out: w.out, guests: "2" },
        { now: NOW, ledgerService: ledger },
      );
      expect(viaQuote.bookable).toBe(true);
      expect(viaQuote.quote).toEqual(w.quote);
    }
  });

  test("a stay that only fits one side is offered from that side only", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(15), 11); // nights 15..25 are taken
    const result = await run(listing(), stay(20, 3), ledger);
    expect(shape(result)[0]).toEqual([
      formatDateOnly(day(26)),
      formatDateOnly(day(29)),
      6,
    ]);
    expect(
      result.windows.every(
        (w) =>
          d(w.in).getTime() >= day(26).getTime() ||
          d(w.out).getTime() <= day(15).getTime(),
      ),
    ).toBe(true);
  });

  test("nothing within 14 days of either end: no windows (not an error)", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(0), 60);
    const result = await run(listing(), stay(20, 3), ledger);
    expect(result).toEqual({ radiusDays: 14, windows: [] });
  });

  test("only gaps shorter than the stay: no windows", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(6), 40);
    // the only free nights near day 20 would need a gap of 3; make gaps of 2 only
    ledger.taken.clear();
    for (let i = 6; i < 40; i += 1)
      if ((i - 6) % 3 !== 2) ledger.taken.add(day(i).getTime());
    const result = await run(listing(), stay(20, 3), ledger);
    expect(result.windows).toEqual([]);
  });

  test("never before today: windows that would start in the past are not offered", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(2), 3);
    const result = await run(listing(), stay(2, 3), ledger);
    expect(result.windows.length).toBeGreaterThan(0);
    for (const w of result.windows)
      expect(d(w.in).getTime()).toBeGreaterThanOrEqual(TODAY.getTime());
    // the ledger is never even asked about nights before today
    expect(
      ledger.availableRanges.mock.calls[0][1].getTime(),
    ).toBeGreaterThanOrEqual(TODAY.getTime());
  });

  test("minimum stay, maximum stay and notice rules are respected", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3);
    // same-length stays of 3 nights, but the host wants 4 or more: nothing is bookable
    expect(
      (await run(listing({ minNights: 4 }), stay(20, 3), ledger)).windows,
    ).toEqual([]);
    // a host who needs 3 days' notice: nothing earlier than 3 days from now is offered
    const near = fakeLedger();
    takeNights(near, day(5), 3);
    const result = await run(
      listing({ advanceNoticeHours: 72 }),
      stay(5, 3),
      near,
    );
    for (const w of result.windows) {
      expect(
        bookingProblems({
          listing: listing({ advanceNoticeHours: 72 }),
          checkIn: d(w.in),
          checkOut: d(w.out),
          guests: 2,
          now: NOW,
        }),
      ).toEqual([]);
    }
  });

  test("over capacity: nothing is offered", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3);
    expect(
      (await run(listing({ capacity: { guests: 1 } }), stay(20, 3, 2), ledger))
        .windows,
    ).toEqual([]);
  });

  test("a suggestion taken between the ledger read and the quote is dropped, and the next one used", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3);
    const first = formatDateOnly(day(17));
    const real = ledger.unavailableDates.getMockImplementation();
    ledger.unavailableDates.mockImplementation(async (id, from, to) =>
      formatDateOnly(from) === first ? [from] : real(id, from, to),
    );
    const result = await run(listing(), stay(20, 3), ledger);
    expect(result.windows.map((w) => w.in)).not.toContain(first);
    expect(result.windows.length).toBe(3);
  });

  test("at most 3 windows by default; the limit is an option", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(20), 3);
    expect((await run(listing(), stay(20, 3), ledger)).windows).toHaveLength(3);
    expect(
      (await run(listing(), stay(20, 3), ledger, { max: 1 })).windows,
    ).toHaveLength(1);
    expect(
      (await run(listing(), stay(20, 3), ledger, { max: 5 })).windows,
    ).toHaveLength(5);
  });

  test("a longer stay (14 nights) still stays inside the ledger's range limit", async () => {
    const ledger = fakeLedger();
    takeNights(ledger, day(30), 14);
    const result = await run(listing(), stay(30, 14), ledger);
    expect(result.windows.length).toBeGreaterThan(0);
    const [, from, to] = ledger.availableRanges.mock.calls[0];
    expect(nightsBetween(from, to)).toBeLessThanOrEqual(400);
  });
});

// ---- property test: against a brute-force oracle ---------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Every window the rules, the calendar and the radius allow, brute force, nearest first. */
function oracle(l, ledger, request, { radiusDays = 14, max = 3 } = {}) {
  const nights = nightsBetween(request.checkIn, request.checkOut);
  const all = [];
  for (let shift = -radiusDays; shift <= radiusDays; shift += 1) {
    if (shift === 0) continue;
    const start = addDays(request.checkIn, shift);
    const end = addDays(start, nights);
    let free = true;
    for (let i = 0; i < nights; i += 1)
      if (ledger.taken.has(addDays(start, i).getTime())) free = false;
    if (!free) continue;
    if (
      bookingProblems({
        listing: l,
        checkIn: start,
        checkOut: end,
        guests: request.guests,
        now: NOW,
      }).length
    )
      continue;
    all.push({ start, end, shift });
  }
  all.sort(
    (a, b) => Math.abs(a.shift) - Math.abs(b.shift) || a.shift - b.shift,
  );
  const chosen = [];
  for (const c of all) {
    if (chosen.length >= max) break;
    if (
      chosen.some(
        (w) =>
          c.start.getTime() < w.end.getTime() &&
          c.end.getTime() > w.start.getTime(),
      )
    )
      continue;
    chosen.push(c);
  }
  return chosen.map((c) => [
    formatDateOnly(c.start),
    formatDateOnly(c.end),
    c.shift,
  ]);
}

describe("property: every suggestion is bookable when it is made", () => {
  test("500 random calendars, rules and requests agree with a brute-force oracle", async () => {
    const rand = lcg(20261024);
    const pick = (a, b) => a + Math.floor(rand() * (b - a + 1));
    let withSuggestions = 0;
    for (let round = 0; round < 500; round += 1) {
      const ledger = fakeLedger();
      for (let i = -2; i < 70; i += 1)
        if (rand() < 0.55) ledger.taken.add(day(i).getTime()); // busy listing
      const l = listing({
        minNights: pick(1, 3),
        maxNights: pick(4, 14),
        advanceNoticeHours: [0, 0, 24, 72][pick(0, 3)],
        capacity: { guests: pick(1, 4) },
      });
      const nights = pick(1, 6);
      const inDay = pick(0, 40);
      const request = {
        checkIn: day(inDay),
        checkOut: day(inDay + nights),
        guests: pick(1, 4),
      };
      // the requested stay is taken
      takeNights(ledger, request.checkIn, nights);

      const { windows } = await run(l, request, ledger);
      expect(windows.map((w) => [w.in, w.out, w.shiftDays])).toEqual(
        oracle(l, ledger, request),
      );

      if (windows.length) withSuggestions += 1;
      let previousEnd = null;
      for (const w of windows) {
        const start = d(w.in);
        const end = d(w.out);
        // same length, within +-14 days, not the requested stay, never in the past
        expect(nightsBetween(start, end)).toBe(nights);
        expect(Math.abs(w.shiftDays)).toBeLessThanOrEqual(14);
        expect(w.shiftDays).not.toBe(0);
        expect(start.getTime()).toBeGreaterThanOrEqual(TODAY.getTime());
        // free in the ledger and acceptable to every booking rule at generation time
        for (let i = 0; i < nights; i += 1)
          expect(ledger.taken.has(addDays(start, i).getTime())).toBe(false);
        expect(
          bookingProblems({
            listing: l,
            checkIn: start,
            checkOut: end,
            guests: request.guests,
            now: NOW,
          }),
        ).toEqual([]);
        const quote = await getQuote(
          l,
          { in: w.in, out: w.out, guests: String(request.guests) },
          { now: NOW, ledgerService: ledger },
        );
        expect(quote.bookable).toBe(true);
        // distinct stays
        if (previousEnd)
          expect(
            windows.filter((o) => o !== w && d(o.in) < end && d(o.out) > start),
          ).toEqual([]);
        previousEnd = end;
      }
      expect(windows.length).toBeLessThanOrEqual(3);
    }
    // the calendars were busy but not hopeless: the property was exercised
    expect(withSuggestions).toBeGreaterThan(100);
  });
});
