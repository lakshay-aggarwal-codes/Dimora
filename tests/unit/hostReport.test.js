// P13-T04: the report's rules and the CSV against fakes (no database).
const { ObjectId } = require("mongoose").Types;
const report = require("../../src/services/hostReport");

const NOW = new Date("2026-10-29T06:00:00Z");
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const fails = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
};

describe("parseRange", () => {
  test("defaults to the last 3 months ending this month", () => {
    const r = report.parseRange({}, { now: NOW });
    expect([r.fromKey, r.toKey]).toEqual(["2026-08", "2026-10"]);
    expect(r.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(r.days).toBe(31 + 30 + 31);
  });

  test("one month, and from alone", () => {
    const one = report.parseRange({ from: "2026-02", to: "2026-02" }, { now: NOW });
    expect(one.days).toBe(28);
    const onlyTo = report.parseRange({ to: "2026-05" }, { now: NOW });
    expect(onlyTo.fromKey).toBe("2026-03");
    const onlyFrom = report.parseRange({ from: "2026-09" }, { now: NOW });
    expect([onlyFrom.fromKey, onlyFrom.toKey]).toEqual(["2026-09", "2026-10"]);
  });

  test("12 months is the longest; 13 is refused", () => {
    expect(report.parseRange({ from: "2025-11", to: "2026-10" }, { now: NOW }).days).toBe(365);
    expect(fails(() => report.parseRange({ from: "2025-10", to: "2026-10" }, { now: NOW })).message).toMatch(/at most 12/);
  });

  test("bad, reversed and out-of-reach months are refused with a plain message", () => {
    for (const q of [{ from: "2026-13" }, { from: "2026-1" }, { from: "abc" }, { to: "2026-10-01" }, { from: ["2026-01", "2026-02"] }, { from: { x: 1 } }]) {
      expect(fails(() => report.parseRange(q, { now: NOW })).statusCode).toBe(400);
    }
    expect(fails(() => report.parseRange({ from: "2026-10", to: "2026-09" }, { now: NOW })).message).toMatch(/cannot be after/);
    expect(fails(() => report.parseRange({ from: "2020-01", to: "2020-02" }, { now: NOW })).message).toMatch(/last 24 months/);
    expect(fails(() => report.parseRange({ from: "2028-01", to: "2028-02" }, { now: NOW })).message).toMatch(/next 12/);
  });

  test("the month is taken in India time", () => {
    const lateOnThe30th = new Date("2026-10-31T19:00:00Z"); // 1 Nov, 00:30 in India
    expect(report.parseRange({}, { now: lateOnThe30th }).toKey).toBe("2026-11");
  });
});

describe("overlapNights and occupancyPercent", () => {
  test("nights of a stay inside the range", () => {
    const start = utc(2026, 10, 1);
    const end = utc(2026, 11, 1);
    expect(report.overlapNights(utc(2026, 10, 5), utc(2026, 10, 8), start, end)).toBe(3);
    expect(report.overlapNights(utc(2026, 9, 29), utc(2026, 10, 3), start, end)).toBe(2); // began earlier
    expect(report.overlapNights(utc(2026, 10, 30), utc(2026, 11, 4), start, end)).toBe(2); // ends later
    expect(report.overlapNights(utc(2026, 9, 1), utc(2026, 9, 5), start, end)).toBe(0);
    expect(report.overlapNights(utc(2026, 11, 1), utc(2026, 11, 3), start, end)).toBe(0);
  });

  test("a whole percent, at most 100, none without available nights", () => {
    expect(report.occupancyPercent(10, 31)).toBe(32);
    expect(report.occupancyPercent(0, 31)).toBe(0);
    expect(report.occupancyPercent(40, 31)).toBe(100);
    expect(report.occupancyPercent(5, 0)).toBeNull();
  });
});

describe("CSV", () => {
  test("minor units to a decimal string without floats", () => {
    expect(report.minorToDecimal(0)).toBe("0.00");
    expect(report.minorToDecimal(5)).toBe("0.05");
    expect(report.minorToDecimal(123450)).toBe("1234.50");
    expect(report.minorToDecimal(9007199254740991)).toBe("90071992547409.91");
    expect(report.minorToDecimal(1200, 0)).toBe("1200");
    expect(report.currencyDigits("INR")).toBe(2);
    expect(report.currencyDigits("JPY")).toBe(0);
  });

  test("cells are quoted when needed and formulas are defused", () => {
    expect(report.csvCell("plain")).toBe("plain");
    expect(report.csvCell("a,b")).toBe('"a,b"');
    expect(report.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(report.csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(report.csvCell(null)).toBe("");
    expect(report.csvCell(7)).toBe("7");
    for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(report.csvCell(evil).replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  const sample = {
    range: { fromKey: "2026-10", toKey: "2026-10", firstDay: "2026-10-01", lastDay: "2026-10-31", days: 31 },
    rows: [
      { id: "a1", title: '=1+1, "Sea" house', status: "published", currency: "INR", bookings: 2, nightsBooked: 10, nightsBlocked: 1, nightsAvailable: 30, occupancy: 33, earningsMinor: 1234500 },
      { id: "b2", title: "Hill cabin", status: "unpublished", currency: "JPY", bookings: 0, nightsBooked: 0, nightsBlocked: 31, nightsAvailable: 0, occupancy: null, earningsMinor: 0 },
    ],
    totals: [],
  };

  test("a byte-order mark, CRLF lines, a fixed header and one line per listing", () => {
    const csv = report.toCsv(sample);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(report.CSV_HEADER.join(","));
    expect(lines[1]).toBe(`"'=1+1, ""Sea"" house",a1,published,2026-10-01,2026-10-31,2,10,1,30,33,12345.00,INR`);
    expect(lines[2]).toBe("Hill cabin,b2,unpublished,2026-10-01,2026-10-31,0,0,31,0,,0,JPY");
  });
});

describe("buildReport with fakes", () => {
  const host = new ObjectId();
  const sea = { _id: new ObjectId(), title: "Sea house", status: "published", pricing: { currency: "INR" } };
  const hill = { _id: new ObjectId(), title: "Hill cabin", status: "unpublished", pricing: { currency: "INR" } };
  const line = (code, amountMinor) => ({ code, amountMinor });
  const snap = (nights, cleaning, fee = 50000) => ({
    currency: "INR",
    lines: [line("nights", nights), line("cleaning", cleaning), line("service_fee", fee), line("tax", 99999)],
  });
  const stay = (listing, inD, outD, pricingSnapshot) => ({ listing: listing._id, checkIn: inD, checkOut: outD, pricingSnapshot });

  function models({ listings = [sea, hill], stays = [], blocks = [] } = {}) {
    const chain = (rows) => {
      const c = { sort: () => c, limit: () => c, select: () => c, lean: async () => rows };
      return c;
    };
    return {
      ListingModel: { find: () => chain(listings) },
      ReservationModel: { find: () => chain(stays) },
      StayNightModel: { find: () => chain(blocks) },
    };
  }
  const run = (m, query = { from: "2026-10", to: "2026-10" }) => report.buildReport(m, host, query, { now: NOW });

  test("earnings are the host's lines only, counted in the month the stay starts", async () => {
    const out = await run(
      models({
        stays: [
          stay(sea, utc(2026, 10, 5), utc(2026, 10, 8), snap(300000, 100000)), // starts in range
          stay(sea, utc(2026, 9, 29), utc(2026, 10, 3), snap(400000, 100000)), // began earlier: nights yes, earnings no
        ],
      }),
    );
    const row = out.rows.find((r) => r.id === String(sea._id));
    expect(row.bookings).toBe(1);
    expect(row.earningsMinor).toBe(400000); // 300000 + 100000: no service fee, no tax
    expect(row.nightsBooked).toBe(3 + 2);
  });

  test("occupancy is booked nights over days minus blocked nights", async () => {
    const out = await run(
      models({
        stays: [stay(sea, utc(2026, 10, 1), utc(2026, 10, 11), snap(1000000, 0))], // 10 nights
        blocks: [{ listing: sea._id }, { listing: sea._id }, { listing: hill._id }],
      }),
    );
    const row = out.rows.find((r) => r.id === String(sea._id));
    expect([row.nightsBooked, row.nightsBlocked, row.nightsAvailable]).toEqual([10, 2, 29]);
    expect(row.occupancy).toBe(34);
    const other = out.rows.find((r) => r.id === String(hill._id));
    expect([other.nightsBooked, other.nightsAvailable, other.occupancy]).toEqual([0, 30, 0]);
  });

  test("totals add up per currency and never mix currencies", async () => {
    const usd = { _id: new ObjectId(), title: "USD flat", status: "published", pricing: { currency: "USD" } };
    const out = await run(
      models({
        listings: [sea, usd],
        stays: [
          stay(sea, utc(2026, 10, 5), utc(2026, 10, 7), snap(200000, 0)),
          { ...stay(usd, utc(2026, 10, 9), utc(2026, 10, 10), { currency: "USD", lines: [line("nights", 9900)] }) },
        ],
      }),
    );
    expect(out.totals.map((t) => [t.currency, t.earningsMinor, t.bookings]).sort()).toEqual([
      ["INR", 200000, 1],
      ["USD", 9900, 1],
    ]);
  });

  test("a stay of another listing is ignored; no listings gives an empty report without querying stays", async () => {
    const stranger = { _id: new ObjectId() };
    const out = await run(models({ stays: [stay(stranger, utc(2026, 10, 5), utc(2026, 10, 7), snap(1, 1))] }));
    expect(out.rows.reduce((n, r) => n + r.bookings, 0)).toBe(0);
    let touched = false;
    const m = models({ listings: [] });
    m.ReservationModel.find = () => {
      touched = true;
    };
    const empty = await run(m);
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toEqual([]);
    expect(touched).toBe(false);
  });

  test("an unreadable price counts as zero rather than failing", async () => {
    const out = await run(models({ stays: [stay(sea, utc(2026, 10, 5), utc(2026, 10, 7), undefined), stay(sea, utc(2026, 10, 9), utc(2026, 10, 10), { lines: [{ code: "nights", amountMinor: "x" }] })] }));
    const row = out.rows.find((r) => r.id === String(sea._id));
    expect([row.bookings, row.earningsMinor]).toEqual([2, 0]);
  });

  test("the range block describes the months", async () => {
    const out = await run(models(), { from: "2026-09", to: "2026-10" });
    expect(out.range).toEqual({ fromKey: "2026-09", toKey: "2026-10", firstDay: "2026-09-01", lastDay: "2026-10-31", days: 61 });
  });

  test("a bad range fails before any query", async () => {
    const m = models();
    m.ListingModel.find = () => {
      throw new Error("must not query");
    };
    await expect(run(m, { from: "nope" })).rejects.toThrow(/YYYY-MM/);
  });
});
