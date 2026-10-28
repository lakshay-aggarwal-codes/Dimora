// P14-T05: cleaning of the audit log filters (no database).
const { cleanFilters } = require("../../src/services/audit");

describe("cleanFilters", () => {
  test("nothing given: every filter empty", () => {
    expect(cleanFilters()).toMatchObject({ action: "", actor: "", targetType: "", from: "", to: "" });
    expect(cleanFilters({}).fromDate).toBeNull();
  });

  test("keeps good values, trims and lower-cases the action", () => {
    const f = cleanFilters({ action: "  User.Suspend ", actor: " chief ", targetType: "listing", from: "2026-03-01", to: "2026-03-31" });
    expect(f).toMatchObject({ action: "user.suspend", actor: "chief", targetType: "listing", from: "2026-03-01", to: "2026-03-31" });
    expect(f.fromDate.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(f.toDate.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  test("an action that is not a plain dotted name is dropped (no patterns)", () => {
    for (const action of [".*", "user|listing", "(", "user suspend", "1user", "user$"]) {
      expect(cleanFilters({ action }).action).toBe("");
    }
    expect(cleanFilters({ action: "user." }).action).toBe("user.");
  });

  test("an unknown target type is dropped", () => {
    expect(cleanFilters({ targetType: "everything" }).targetType).toBe("");
    for (const t of ["user", "listing", "review", "report", "reservation", "system"]) {
      expect(cleanFilters({ targetType: t }).targetType).toBe(t);
    }
  });

  test("a date must be a real YYYY-MM-DD", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-5", "2026-03-01T00:00:00Z", "yesterday", "", " "]) {
      const f = cleanFilters({ from: bad, to: bad });
      expect({ bad, from: f.from, to: f.to }).toEqual({ bad, from: "", to: "" });
    }
  });

  test("values that are not strings are ignored (?action=a&action=b, ?actor[x]=1)", () => {
    const f = cleanFilters({ action: ["a", "b"], actor: { x: 1 }, targetType: 5, from: 20260301, to: null });
    expect(f).toMatchObject({ action: "", actor: "", targetType: "", from: "", to: "" });
  });

  test("text is cut to 80 characters", () => {
    expect(cleanFilters({ actor: "x".repeat(500) }).actor).toHaveLength(80);
  });
});
