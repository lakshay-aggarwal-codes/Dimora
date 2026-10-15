// P03-T02: <title> and meta description helpers.
const {
  fullTitle,
  metaDescription,
  DEFAULT_DESCRIPTION,
} = require("../../src/utils/pageMeta");

describe("fullTitle", () => {
  test("adds the site name", () => {
    expect(fullTitle("Log in")).toBe("Log in | Dimora");
  });
  test("falls back to the site name without a page title", () => {
    for (const v of [undefined, null, "", "   ", "\n\t"])
      expect(fullTitle(v)).toBe("Dimora");
  });
  test("collapses whitespace and line breaks", () => {
    expect(fullTitle("  Sea \n  view\tcottage ")).toBe(
      "Sea view cottage | Dimora",
    );
  });
  test("long titles are shortened", () => {
    const t = fullTitle("x".repeat(200));
    expect(t.length).toBeLessThanOrEqual(70 + " | Dimora".length);
    expect(t).toContain("…");
  });
  test("non-string values do not throw", () => {
    expect(fullTitle(42)).toBe("42 | Dimora");
    expect(fullTitle({})).toContain("| Dimora");
  });
});

describe("metaDescription", () => {
  test("uses the default when empty", () => {
    expect(metaDescription("")).toBe(DEFAULT_DESCRIPTION);
    expect(metaDescription(undefined)).toBe(DEFAULT_DESCRIPTION);
  });
  test("short text is kept, whitespace squashed", () => {
    expect(metaDescription("A quiet\n  place.")).toBe("A quiet place.");
  });
  test("long text is cut at a word boundary under 160 characters", () => {
    const text = "word ".repeat(100);
    const out = metaDescription(text);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
  test("one very long word is still cut", () => {
    expect(metaDescription("a".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});
