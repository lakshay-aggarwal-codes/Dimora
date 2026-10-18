// P05-T02: the listings page's URL parameters (no database).
const {
  parseListingQuery,
  SORTS,
} = require("../../src/validation/searchQuery");
const {
  queryPairs,
  listingsUrl,
  hiddenFields,
} = require("../../src/utils/searchUrl");

const NOW = new Date("2026-10-17T10:00:00Z"); // 15:30 in India, still the 17th
const parse = (query) => parseListingQuery(query, { now: NOW });

describe("names and aliases", () => {
  test("the URL names map to the state, numbers become numbers", () => {
    const { state, errors } = parse({
      dest: "Goa",
      guests: "4",
      minPrice: "1000",
      maxPrice: "5000",
      type: "villa",
      amenities: ["wifi", "pool"],
      minRating: "4",
      sort: "price_asc",
      page: "2",
    });
    expect(errors).toEqual({});
    expect(state).toEqual({
      dest: "Goa",
      guests: 4,
      minPrice: 1000,
      maxPrice: 5000,
      type: ["villa"],
      amenities: ["wifi", "pool"],
      minRating: 4,
      sort: "price_asc",
      page: 2,
    });
  });

  test("destination and the navbar's old `search` mean dest; dest wins", () => {
    expect(parse({ destination: "Goa" }).state.dest).toBe("Goa");
    expect(parse({ search: "Goa" }).state.dest).toBe("Goa");
    expect(
      parse({ dest: "Pune", destination: "Goa", search: "Delhi" }).state.dest,
    ).toBe("Pune");
  });

  test("amenities[] and a single amenities value are lists; propertyType means type", () => {
    expect(parse({ "amenities[]": ["wifi", "pool"] }).state.amenities).toEqual([
      "wifi",
      "pool",
    ]);
    expect(parse({ "amenities[]": "wifi" }).state.amenities).toEqual(["wifi"]);
    expect(parse({ amenities: "wifi" }).state.amenities).toEqual(["wifi"]);
    expect(parse({ propertyType: "cabin" }).state.type).toEqual(["cabin"]);
  });

  test("the search service's own names still work", () => {
    const { state } = parse({
      keywords: "sea",
      bedrooms: "2",
      roomType: "entire_place",
      instantBook: "1",
    });
    expect(state).toEqual({
      keywords: "sea",
      bedrooms: 2,
      roomType: ["entire_place"],
      instantBook: true,
    });
  });

  test("empty values mean 'not set'; unknown names and prototype keys are ignored", () => {
    const { state, errors } = parse({
      dest: "",
      guests: "",
      minPrice: "",
      sort: "",
      page: "",
      foo: "1",
      __proto__: "x",
      constructor: "y",
      category: "beaches",
    });
    expect(state).toEqual({});
    expect(errors).toEqual({});
  });

  test.each([undefined, null, "string", 5, [], ["a"]])(
    "a query that is not an object (%p) is an empty search",
    (query) => {
      expect(parse(query)).toMatchObject({
        state: {},
        errors: {},
        stay: null,
        page: 1,
      });
    },
  );

  test("searchParams are the same filters under the service's names", () => {
    const { searchParams } = parse({ dest: "Goa", type: "villa", guests: "2" });
    expect(searchParams).toEqual({
      destination: "Goa",
      propertyType: ["villa"],
      guests: 2,
    });
  });
});

describe("wrong values are reported and never become operators", () => {
  test.each([
    ["a list where one value belongs", { guests: ["1", "9"] }, "guests"],
    ["a list for the destination", { dest: ["a", "b"] }, "dest"],
    ["a word instead of a number", { guests: "many" }, "guests"],
    ["too many guests", { guests: "99" }, "guests"],
    ["zero guests", { guests: "0" }, "guests"],
    ["a decimal number of guests", { guests: "1.5" }, "guests"],
    ["a negative price", { minPrice: "-5" }, "minPrice"],
    ["a huge price", { maxPrice: "99999999" }, "maxPrice"],
    [
      "minimum above maximum",
      { minPrice: "9000", maxPrice: "1000" },
      "maxPrice",
    ],
    ["an unknown property type", { type: "castle" }, "type"],
    ["an unknown amenity", { amenities: ["wifi", "jacuzzi"] }, "amenities"],
    ["a rating of 0", { minRating: "0" }, "minRating"],
    ["a rating of 6", { minRating: "6" }, "minRating"],
    ["a rating that is text", { minRating: "good" }, "minRating"],
    ["an unknown sort", { sort: "cheapest" }, "sort"],
    ["a sort list", { sort: ["price_asc", "rating"] }, "sort"],
  ])("%s", (_name, query, field) => {
    const { errors, state } = parse(query);
    expect(Object.keys(errors)).toContain(field);
    expect(typeof errors[field]).toBe("string");
    expect(errors[field].length).toBeGreaterThan(5);
    expect(state[field === "type" ? "type" : field]).toBeUndefined();
  });

  test.each([["0"], ["-1"], ["1.5"], ["abc"], ["1001"], [["1", "2"]]])(
    "page %p is an error and page 1",
    (page) => {
      const result = parse({ page });
      expect(result.errors.page).toBeDefined();
      expect(result.page).toBe(1);
      expect(result.state.page).toBeUndefined();
    },
  );

  test("operator-looking names are just unknown names", () => {
    const { state, errors } = parse({
      "guests[$gt]": "1",
      "dest[$ne]": "x",
      $where: "1",
    });
    expect(state).toEqual({});
    expect(errors).toEqual({});
  });

  test("the valid parameters still count when others are wrong", () => {
    const { state, errors, searchParams } = parse({
      dest: "Goa",
      guests: "many",
      type: "villa",
    });
    expect(state).toEqual({ dest: "Goa", type: ["villa"] });
    expect(Object.keys(errors)).toEqual(["guests"]);
    expect(searchParams).toEqual({
      destination: "Goa",
      propertyType: ["villa"],
    });
  });

  test("one message per problem, in plain words", () => {
    const { errors } = parse({ guests: "many", sort: "x" });
    expect(errors.guests).toMatch(/Guests/);
    expect(errors.sort).toMatch(/Sort must be one of/);
    for (const sort of SORTS) expect(errors.sort).toContain(sort);
  });
});

describe("dates", () => {
  test("valid dates become state and a stay", () => {
    const { state, stay, errors } = parse({
      in: "2026-12-24",
      out: "2026-12-27",
    });
    expect(errors).toEqual({});
    expect(state).toMatchObject({ in: "2026-12-24", out: "2026-12-27" });
    expect(stay.checkIn.toISOString()).toBe("2026-12-24T00:00:00.000Z");
    expect(stay.checkOut.toISOString()).toBe("2026-12-27T00:00:00.000Z");
  });

  test("today is allowed as check-in (listing time zone)", () => {
    expect(parse({ in: "2026-10-17", out: "2026-10-18" }).errors).toEqual({});
    expect(parse({ in: "2026-10-16", out: "2026-10-18" }).errors.in).toBe(
      "Check-in cannot be in the past.",
    );
  });

  test("'today' follows the time zone: late on the 17th UTC is already the 18th in India", () => {
    const late = new Date("2026-10-17T20:00:00Z");
    expect(
      parseListingQuery({ in: "2026-10-17", out: "2026-10-19" }, { now: late })
        .errors.in,
    ).toBe("Check-in cannot be in the past.");
    expect(
      parseListingQuery(
        { in: "2026-10-17", out: "2026-10-19" },
        { now: late, timeZone: "America/Los_Angeles" },
      ).errors,
    ).toEqual({});
  });

  test.each([
    ["2026-02-30", "not a real day"],
    ["2026-13-01", "month 13"],
    ["2026-1-5", "no zero padding"],
    ["26-12-24", "two-digit year"],
    ["2026-12-24T00:00:00Z", "a timestamp"],
    [" 2026-12-24", "leading space"],
    ["24/12/2026", "another format"],
    ["tomorrow", "a word"],
    ["0000-12-24", "year 0"],
  ])("%s (%s) is refused", (value) => {
    const { errors, state, stay } = parse({ in: value, out: "2027-01-02" });
    expect(errors.in).toBe("Check-in must be a date like 2026-12-24.");
    expect(state.in).toBeUndefined();
    expect(stay).toBeNull();
  });

  test("one date without the other is asked for, both ways", () => {
    expect(parse({ in: "2026-12-24" }).errors).toEqual({
      out: "Choose a check-out date.",
    });
    expect(parse({ out: "2026-12-24" }).errors).toEqual({
      in: "Choose a check-in date.",
    });
    expect(parse({ in: "2026-12-24", out: "" }).stay).toBeNull();
  });

  test("check-out must be after check-in", () => {
    expect(parse({ in: "2026-12-24", out: "2026-12-24" }).errors.out).toBe(
      "Check-out must be after check-in.",
    );
    expect(parse({ in: "2026-12-24", out: "2026-12-20" }).errors.out).toBe(
      "Check-out must be after check-in.",
    );
  });

  test("a stay is at most 90 nights; 90 is fine", () => {
    expect(parse({ in: "2026-11-01", out: "2027-01-30" }).errors).toEqual({}); // 90 nights
    expect(parse({ in: "2026-11-01", out: "2027-01-31" }).errors.out).toBe(
      "A stay can be at most 90 nights.",
    );
  });

  test("check-in at most a year ahead", () => {
    expect(parse({ in: "2027-10-17", out: "2027-10-19" }).errors).toEqual({});
    expect(parse({ in: "2027-10-18", out: "2027-10-19" }).errors.in).toBe(
      "Check-in is too far ahead.",
    );
  });

  test("dates given as lists are refused", () => {
    expect(
      parse({ in: ["2026-12-24", "2026-12-25"], out: "2026-12-27" }).errors.in,
    ).toBe("Check-in must be a single date.");
  });

  test("leap day is a real date", () => {
    expect(
      parse(
        { in: "2028-02-29", out: "2028-03-01" },
        { now: new Date("2028-01-01T00:00:00Z") },
      ).errors,
    ).toBeDefined();
  });
});

describe("the form shows what was typed, valid or not", () => {
  test("invalid dates and guests come back as typed", () => {
    const { form } = parse({
      dest: "Gõa & <b>",
      in: "2026-02-30",
      out: "nope",
      guests: "many",
    });
    expect(form).toEqual({
      dest: "Gõa & <b>",
      in: "2026-02-30",
      out: "nope",
      guests: "many",
    });
  });
  test("lists and missing values show as empty; long text is cut", () => {
    const { form } = parse({ dest: ["a", "b"], guests: undefined });
    expect(form).toEqual({ dest: "", in: "", out: "", guests: "" });
    expect(parse({ dest: "x".repeat(500) }).form.dest).toHaveLength(100);
  });
});

describe("links keep the query (round trip)", () => {
  const full = {
    dest: "Goa",
    in: "2026-12-24",
    out: "2026-12-27",
    guests: 2,
    minPrice: 1000,
    maxPrice: 5000,
    type: ["villa", "cabin"],
    amenities: ["wifi", "pool"],
    minRating: 4,
    sort: "price_asc",
    keywords: "sea view",
    bedrooms: 2,
    roomType: ["entire_place"],
    instantBook: true,
  };
  const asQuery = (url) => {
    const out = {};
    for (const [k, v] of new URL(url, "http://x").searchParams)
      out[k] = k in out ? [].concat(out[k], v) : v;
    return out;
  };

  test("parse(listingsUrl(state)) gives the same state", () => {
    const first = parse(asQuery(listingsUrl(full)));
    expect(first.errors).toEqual({});
    expect(first.state).toEqual(full);
    expect(listingsUrl(first.state)).toBe(listingsUrl(full));
  });

  test("each parameter alone round-trips", () => {
    for (const [name, value] of Object.entries(full)) {
      if (name === "in" || name === "out") continue;
      const state = { [name]: value };
      expect(parse(asQuery(listingsUrl(state))).state).toEqual(state);
    }
  });

  test("a messy but valid query is normalised and stable", () => {
    const messy = {
      "amenities[]": ["pool", "wifi"],
      propertyType: "villa",
      destination: "Goa",
      guests: "02",
      page: "3",
    };
    const once = parse(messy).state;
    const url = listingsUrl(once, { page: once.page }); // a pagination link names its page
    expect(url).toBe(
      "/listings?dest=Goa&guests=2&type=villa&amenities=pool&amenities=wifi&page=3",
    );
    expect(parse(asQuery(url)).state).toEqual(once);
  });

  test("special characters survive", () => {
    const state = parse({ dest: "Saint-Étienne & Co, #1 100%" }).state;
    expect(parse(asQuery(listingsUrl(state))).state.dest).toBe(
      "Saint-Étienne & Co, #1 100%",
    );
  });

  test("page 1 and an empty state leave the page parameter out", () => {
    expect(listingsUrl({})).toBe("/listings");
    expect(listingsUrl({ dest: "Goa", page: 1 })).toBe("/listings?dest=Goa");
    expect(listingsUrl({ dest: "Goa" }, { page: 2 })).toBe(
      "/listings?dest=Goa&page=2",
    );
  });

  test("changing a filter or the sort goes back to page 1; changing the page keeps the rest", () => {
    const state = { dest: "Goa", guests: 2, page: 4 };
    expect(listingsUrl(state, { guests: 3 })).toBe(
      "/listings?dest=Goa&guests=3",
    );
    expect(listingsUrl(state, { sort: "rating" })).toBe(
      "/listings?dest=Goa&guests=2&sort=rating",
    );
    expect(listingsUrl(state, { page: 5 })).toBe(
      "/listings?dest=Goa&guests=2&page=5",
    );
  });

  test("a change to undefined, '' or [] removes the parameter", () => {
    const state = { dest: "Goa", amenities: ["wifi"], guests: 2 };
    expect(listingsUrl(state, { guests: undefined })).toBe(
      "/listings?dest=Goa&amenities=wifi",
    );
    expect(listingsUrl(state, { amenities: [] })).toBe(
      "/listings?dest=Goa&guests=2",
    );
    expect(listingsUrl(state, { dest: "" })).toBe(
      "/listings?amenities=wifi&guests=2".replace(
        "amenities=wifi&guests=2",
        "guests=2&amenities=wifi",
      ),
    );
  });

  test("hidden fields carry everything except what the form itself edits (and page)", () => {
    const names = hiddenFields({ ...full, page: 3 }, [
      "dest",
      "in",
      "out",
      "guests",
    ]).map(([n]) => n);
    expect(names).toEqual([
      "minPrice",
      "maxPrice",
      "type",
      "type",
      "amenities",
      "amenities",
      "minRating",
      "sort",
      "keywords",
      "bedrooms",
      "roomType",
      "instantBook",
    ]);
  });

  test("queryPairs gives the same order whatever the order of the input", () => {
    expect(queryPairs({ guests: 2, dest: "Goa" })).toEqual(
      queryPairs({ dest: "Goa", guests: 2 }),
    );
  });
});
