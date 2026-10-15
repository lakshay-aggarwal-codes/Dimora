// P03-T03: page numbers and links
const {
  pageItems,
  pageHref,
  toPage,
  toPageCount,
} = require("../../src/utils/pagination");

const show = (items) =>
  items
    .map((i) =>
      i.type === "gap" ? "…" : i.current ? `[${i.number}]` : String(i.number),
    )
    .join(" ");

describe("pageItems", () => {
  test.each([
    [1, 1, "[1]"],
    [1, 3, "[1] 2 3"],
    [2, 3, "1 [2] 3"],
    [1, 10, "[1] 2 … 10"],
    [5, 10, "1 … 4 [5] 6 … 10"],
    [3, 10, "1 2 [3] 4 … 10"],
    [4, 10, "1 2 3 [4] 5 … 10"],
    [10, 10, "1 … 9 [10]"],
    [9, 10, "1 … 8 [9] 10"],
  ])("page %p of %p -> %s", (page, total, expected) => {
    expect(show(pageItems(page, total))).toBe(expected);
  });

  test("a gap never hides just one page (that page is shown instead)", () => {
    expect(show(pageItems(1, 4))).toBe("[1] 2 3 4");
    expect(show(pageItems(4, 6))).toBe("1 2 3 [4] 5 6");
  });

  test("bad numbers fall back to page 1 and a single page", () => {
    expect(show(pageItems("x", "y"))).toBe("[1]");
    expect(show(pageItems(-4, 3))).toBe("[1] 2 3");
    expect(show(pageItems(99, 3))).toBe("1 2 [3]");
    expect(show(pageItems(2.7, 3))).toBe("1 [2] 3");
    expect(toPageCount(0)).toBe(1);
    expect(toPage(5, 2)).toBe(2);
  });
});

describe("pageHref", () => {
  test("page 1 has no page parameter", () => {
    expect(pageHref("/listings", {}, 1)).toBe("/listings");
    expect(pageHref("/listings", { page: "4" }, 1)).toBe("/listings");
  });
  test("keeps the other parameters (and repeated ones), replaces page", () => {
    expect(
      pageHref("/listings", { search: "goa", page: "3", tag: ["a", "b"] }, 2),
    ).toBe("/listings?search=goa&tag=a&tag=b&page=2");
  });
  test("values are URL-encoded", () => {
    expect(pageHref("/listings", { search: "a&b=c d" }, 2)).toBe(
      "/listings?search=a%26b%3Dc+d&page=2",
    );
  });
  test("empty and nested values are dropped", () => {
    expect(
      pageHref("/listings", { a: "", b: null, c: { d: 1 }, e: undefined }, 2),
    ).toBe("/listings?page=2");
  });
  test.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil.com",
    "listings",
    "/a?x=1",
    "/a#b",
    "/a\nb",
    undefined,
    5,
  ])("an unsafe base %p becomes /", (base) => {
    expect(pageHref(base, {}, 1)).toBe("/");
  });
  test("a custom parameter name", () => {
    expect(pageHref("/trips", { p: "9" }, 3, "p")).toBe("/trips?p=3");
  });
});
