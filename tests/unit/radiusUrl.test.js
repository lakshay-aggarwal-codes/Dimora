// P06-T05: radius in the URL state, chips and counts (pure helpers; no database).
const { queryPairs, listingsUrl } = require("../../src/utils/searchUrl");
const { activeChips, filterCount, resetFiltersHref } = require("../../src/utils/filterChips");
const { describeQuery } = require("../../src/services/savedSearches");

describe("radius in links", () => {
  test("it follows dest in the fixed order and survives every link", () => {
    expect(queryPairs({ guests: 2, radius: 25, dest: "Goa" })).toEqual([["dest", "Goa"], ["radius", "25"], ["guests", "2"]]);
    expect(listingsUrl({ dest: "Goa", radius: 10 }, { sort: "price_asc" })).toBe("/listings?dest=Goa&radius=10&sort=price_asc");
  });
});

describe("chips and counts", () => {
  test("a chip removes only the radius; the filter count includes it; reset removes it", () => {
    const state = { dest: "Goa", radius: 25, guests: 2 };
    const chip = activeChips(state).find((c) => c.key === "radius");
    expect(chip.label).toBe("Within 25 km");
    expect(chip.href).toBe("/listings?dest=Goa&guests=2");
    expect(filterCount(state)).toBe(1);
    expect(resetFiltersHref(state)).toBe("/listings?dest=Goa&guests=2");
  });

  test("a radius without a destination shows nothing", () => {
    expect(activeChips({ radius: 25 }).some((c) => c.key === "radius")).toBe(false);
    expect(filterCount({ radius: 25 })).toBe(0);
  });
});

describe("saved searches", () => {
  test("the summary names the distance", () => {
    expect(describeQuery("dest=Goa&radius=25&guests=2")).toBe("Goa (within 25 km) · 2 guests");
  });
});
