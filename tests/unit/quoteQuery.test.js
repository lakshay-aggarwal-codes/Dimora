// P08-T02: the quote query parser.
const { parseQuoteQuery } = require("../../src/validation/quoteQuery");
const { ValidationError } = require("../../src/utils/errors");
const { formatDateOnly } = require("../../src/utils/dates");

const fieldsOf = (query) => {
  try {
    parseQuoteQuery(query);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    return err.fields;
  }
  throw new Error("did not throw");
};

describe("parseQuoteQuery", () => {
  test("a good query becomes date-only Dates and a number", () => {
    const parsed = parseQuoteQuery({
      in: "2026-11-01",
      out: "2026-11-04",
      guests: "2",
    });
    expect(formatDateOnly(parsed.checkIn)).toBe("2026-11-01");
    expect(formatDateOnly(parsed.checkOut)).toBe("2026-11-04");
    expect(parsed.guests).toBe(2);
  });

  test("every missing field is reported, each under its own name", () => {
    expect(Object.keys(fieldsOf({})).sort()).toEqual(["guests", "in", "out"]);
    expect(Object.keys(fieldsOf(undefined)).sort()).toEqual([
      "guests",
      "in",
      "out",
    ]);
  });

  test.each([
    ["2026-02-30"],
    ["2026-1-5"],
    ["2026-11-01T00:00:00Z"],
    [" 2026-11-01"],
    ["tomorrow"],
    [["2026-11-01", "2026-11-02"]],
    [{ x: "2026-11-01" }],
  ])("a bad check-in %j", (bad) => {
    const fields = fieldsOf({ in: bad, out: "2026-11-04", guests: "2" });
    expect(Object.keys(fields)).toEqual(["in"]);
    expect(fields.in).toMatch(/Check-in/);
  });

  test("check-out must be after check-in (reported on out)", () => {
    for (const out of ["2026-11-01", "2026-10-30"]) {
      expect(fieldsOf({ in: "2026-11-01", out, guests: "1" })).toEqual({
        out: "Check-out must be after check-in.",
      });
    }
  });

  test.each([
    ["0"],
    ["-1"],
    ["1.5"],
    ["two"],
    ["1e2"],
    [" 2"],
    ["1000"],
    [["1", "2"]],
    [2],
  ])("bad guests %j", (bad) => {
    expect(
      Object.keys(
        fieldsOf({ in: "2026-11-01", out: "2026-11-04", guests: bad }),
      ),
    ).toEqual(["guests"]);
  });

  test("several problems are all listed and the first is the message", () => {
    try {
      parseQuoteQuery({ in: "x", out: "2026-11-04", guests: "0" });
    } catch (err) {
      expect(Object.keys(err.fields)).toEqual(["in", "guests"]);
      expect(err.message).toBe(err.fields.in);
    }
  });
});
