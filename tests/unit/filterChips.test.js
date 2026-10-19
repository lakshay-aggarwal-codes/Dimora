// P05-T04: chips, the filter count, the reset link and the category strip.
const {
  activeChips,
  filterCount,
  resetFiltersHref,
  categoryLinks,
  dayLabel,
  PANEL_FIELDS,
} = require("../../src/utils/filterChips");

const decode = (url) => decodeURIComponent(url.replace(/\+/g, " "));

describe("activeChips", () => {
  test("no filters, no chips", () => {
    expect(activeChips({})).toEqual([]);
    expect(activeChips()).toEqual([]);
  });

  test("each active filter is one chip, in a fixed order", () => {
    const state = {
      dest: "Goa",
      in: "2026-12-24",
      out: "2026-12-28",
      guests: 3,
      category: "beach",
      minPrice: 1000,
      maxPrice: 5000,
      type: ["villa"],
      roomType: ["private_room"],
      bedrooms: 2,
      amenities: ["wifi", "pool"],
      instantBook: true,
      minRating: 4,
      keywords: "quiet",
    };
    expect(activeChips(state).map((chip) => chip.label)).toEqual([
      "Where: Goa",
      "24 Dec 2026 to 28 Dec 2026",
      "3 guests",
      "Beach",
      "₹1,000 to ₹5,000 a night",
      "Villa",
      "A private room",
      "2+ bedrooms",
      "Wi-Fi",
      "Pool",
      "Instant book",
      "Rated 4+",
      "Keywords: quiet",
    ]);
  });

  test("a chip's link removes that filter and keeps every other one", () => {
    const state = { dest: "Goa", guests: 2, category: "beach", type: ["villa", "cabin"], page: 3 };
    const byKey = Object.fromEntries(activeChips(state).map((chip) => [chip.key, chip.href]));
    expect(byKey.dest).toBe("/listings?guests=2&category=beach&type=villa&type=cabin");
    expect(byKey.guests).toBe("/listings?dest=Goa&category=beach&type=villa&type=cabin");
    expect(byKey.category).toBe("/listings?dest=Goa&guests=2&type=villa&type=cabin");
    expect(byKey["type:villa"]).toBe("/listings?dest=Goa&guests=2&category=beach&type=cabin");
    expect(byKey["type:cabin"]).toBe("/listings?dest=Goa&guests=2&category=beach&type=villa");
  });

  test("removing a filter goes back to page 1", () => {
    const [chip] = activeChips({ dest: "Goa", page: 4 });
    expect(chip.href).toBe("/listings");
  });

  test("removing the last value of a list drops the parameter", () => {
    const [chip] = activeChips({ amenities: ["wifi"] });
    expect(chip.href).toBe("/listings");
  });

  test("dates are one chip and removing it removes both", () => {
    const chips = activeChips({ dest: "Goa", in: "2026-12-24", out: "2026-12-28" });
    const dates = chips.find((chip) => chip.key === "dates");
    expect(dates.href).toBe("/listings?dest=Goa");
  });

  test("price: only a minimum, only a maximum, or both", () => {
    expect(activeChips({ minPrice: 1500 })[0].label).toBe("From ₹1,500 a night");
    expect(activeChips({ maxPrice: 20000 })[0].label).toBe("Up to ₹20,000 a night");
    expect(activeChips({ minPrice: 0, maxPrice: 3000 })[0].label).toBe("₹0 to ₹3,000 a night");
    expect(activeChips({ minPrice: 1000, maxPrice: 3000 })[0].href).toBe("/listings");
  });

  test("one guest, one bedroom wording; zero bedrooms is not a filter", () => {
    expect(activeChips({ guests: 1 })[0].label).toBe("1 guest");
    expect(activeChips({ bedrooms: 0 })).toEqual([]);
  });

  test("labels are text, not HTML: the view escapes them", () => {
    const [chip] = activeChips({ dest: "<script>x</script>" });
    expect(chip.label).toBe("Where: <script>x</script>");
    expect(chip.href).not.toContain("<");
  });

  test("an unknown category or value is shown as nothing / as itself, never crashes", () => {
    expect(activeChips({ category: "nope" })).toEqual([]);
    expect(activeChips({ type: ["spaceship"] })[0].label).toBe("spaceship");
  });
});

describe("dayLabel", () => {
  test("reads the text, so no time zone can move the day", () => {
    expect(dayLabel("2026-01-05")).toBe("5 Jan 2026");
    expect(dayLabel("2026-12-31")).toBe("31 Dec 2026");
    expect(dayLabel("soon")).toBe("soon");
  });
});

describe("filterCount", () => {
  test("counts what the panel edits; a price range counts once", () => {
    expect(filterCount({})).toBe(0);
    expect(filterCount({ minPrice: 1, maxPrice: 2 })).toBe(1);
    expect(filterCount({ type: ["villa", "cabin"], roomType: ["shared_room"] })).toBe(3);
    expect(filterCount({ bedrooms: 2, amenities: ["wifi", "pool"], instantBook: true })).toBe(4);
  });

  test("search, dates, guests, category and sort are not panel filters", () => {
    expect(filterCount({ dest: "Goa", in: "2026-12-24", out: "2026-12-28", guests: 2, category: "beach", sort: "rating" })).toBe(0);
  });
});

describe("resetFiltersHref", () => {
  test("drops the panel's filters and the category, keeps the search", () => {
    const state = {
      dest: "Goa",
      in: "2026-12-24",
      out: "2026-12-28",
      guests: 2,
      category: "beach",
      minPrice: 1000,
      type: ["villa"],
      amenities: ["pool"],
      instantBook: true,
      sort: "price_asc",
      page: 2,
    };
    expect(decode(resetFiltersHref(state))).toBe(
      "/listings?dest=Goa&in=2026-12-24&out=2026-12-28&guests=2&sort=price_asc",
    );
  });

  test("nothing to reset is just the listings page", () => {
    expect(resetFiltersHref({})).toBe("/listings");
  });

  test("PANEL_FIELDS are the URL names of the panel's inputs", () => {
    expect(PANEL_FIELDS).toEqual(["minPrice", "maxPrice", "type", "roomType", "bedrooms", "amenities", "instantBook"]);
  });
});

describe("categoryLinks", () => {
  test("All stays first, then every category", () => {
    const links = categoryLinks({});
    expect(links[0]).toMatchObject({ slug: "", label: "All stays", href: "/listings", active: true });
    expect(links).toHaveLength(13);
    expect(links.filter((link) => link.active)).toHaveLength(1);
  });

  test("the current category is marked and All is not", () => {
    const links = categoryLinks({ category: "cabins" });
    expect(links.find((link) => link.active).slug).toBe("cabins");
    expect(links[0].active).toBe(false);
  });

  test("a link keeps the search and the other filters, and goes back to page 1", () => {
    const links = categoryLinks({ dest: "Goa", guests: 2, minPrice: 500, page: 3 });
    const beach = links.find((link) => link.slug === "beach");
    expect(beach.href).toBe("/listings?dest=Goa&guests=2&category=beach&minPrice=500");
    expect(links[0].href).toBe("/listings?dest=Goa&guests=2&minPrice=500");
  });

  test("choosing All removes the category", () => {
    expect(categoryLinks({ category: "beach", dest: "Goa" })[0].href).toBe("/listings?dest=Goa");
  });

  test("an unknown category in the state marks nothing but All", () => {
    const links = categoryLinks({ category: "nope" });
    expect(links[0].active).toBe(true);
    expect(links.filter((link) => link.active)).toHaveLength(1);
  });
});
