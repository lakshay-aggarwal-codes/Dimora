// P05-T05: what an empty search offers (no database: the model is a fake that
// answers counts by looking at the filter it was given).
const {
  suggestForEmptyResults,
  popularDestinations,
  MAX_EXTRA_QUERIES,
  MAX_FILTER_SUGGESTIONS,
  GROUPS,
} = require("../../src/services/suggestions");
const { destinationParts } = require("../../src/utils/searchKeys");

// A tiny "database" of listings that really applies the filter the service builds.
const STAYS = [
  { _id: "a", cityKey: "panaji", stateKey: "goa", countryKey: "india", pricing: { nightlyMinor: 600000 }, capacity: { guests: 8, bedrooms: 4 }, propertyType: "villa", roomType: "entire_place", amenities: ["wifi", "pool"], instantBook: true, address: { city: "Panaji" } },
  { _id: "b", cityKey: "margao", stateKey: "goa", countryKey: "india", pricing: { nightlyMinor: 90000 }, capacity: { guests: 2, bedrooms: 1 }, propertyType: "apartment", roomType: "private_room", amenities: ["wifi"], instantBook: false, address: { city: "Margao" } },
  { _id: "c", cityKey: "manali", stateKey: "himachal pradesh", countryKey: "india", pricing: { nightlyMinor: 350000 }, capacity: { guests: 4, bedrooms: 2 }, propertyType: "cabin", roomType: "entire_place", amenities: ["heating", "wifi"], instantBook: false, address: { city: "Manali" } },
  { _id: "d", cityKey: "panaji", stateKey: "goa", countryKey: "india", pricing: { nightlyMinor: 150000 }, capacity: { guests: 3, bedrooms: 1 }, propertyType: "apartment", roomType: "entire_place", amenities: [], instantBook: false, address: { city: "Panaji" } },
];

function matches(stay, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "status" || key === "deletedAt") continue;
    if (key === "_id") { if (cond.$nin && cond.$nin.includes(stay._id)) return false; continue; }
    if (key === "$and") {
      for (const part of cond) {
        const ok = part.$or.some((c) => {
          const [field, re] = Object.entries(c)[0];
          return re.test(stay[field]);
        });
        if (!ok) return false;
      }
      continue;
    }
    if (key === "$text") continue;
    const value = key.split(".").reduce((n, k) => (n == null ? undefined : n[k]), stay);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if (cond.$gte !== undefined && !(value >= cond.$gte)) return false;
      if (cond.$lte !== undefined && !(value <= cond.$lte)) return false;
      if (cond.$in && !cond.$in.includes(value)) return false;
      if (cond.$all && !cond.$all.every((x) => (value || []).includes(x))) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

function fakeListing(stays = STAYS) {
  const calls = { counts: 0, finds: 0, countFilters: [] };
  return {
    calls,
    async countDocuments(filter) {
      calls.counts += 1;
      calls.countFilters.push(filter);
      return stays.filter((s) => matches(s, filter)).length;
    },
    find(filter) {
      calls.finds += 1;
      const chain = {
        select: () => chain,
        sort: () => chain,
        limit: () => chain,
        lean: () => Promise.resolve(stays.filter((s) => matches(s, filter))),
      };
      return chain;
    },
  };
}

const { buildFilter } = require("../../src/services/search");
const parsedFrom = (searchParams, state, stay = null) => ({ searchParams, state: { ...state }, stay });

describe("filter suggestions", () => {
  test("a filter whose removal gives stays is offered, with the number of stays", async () => {
    const parsed = parsedFrom({ destination: "Panaji", guests: 9 }, { dest: "Panaji", guests: 9 });
    const out = await suggestForEmptyResults({ Listing: fakeListing(), parsed });
    expect(out.filterSuggestions.map((s) => [s.key, s.count])).toEqual([["guests", 2]]); // dropping the destination: still 0 (nobody sleeps 9)
    expect(out.filterSuggestions[0].label).toBe("Remove the guest count (9 guests)");
    expect(out.filterSuggestions[0].url).toBe("/listings?dest=Panaji");
  });

  test("the filter that gives most stays comes first; at most three are offered", async () => {
    const parsed = parsedFrom(
      { destination: "Panaji", minPrice: 5000, maxPrice: 1200, guests: 7, propertyType: ["cabin"], amenities: ["pool", "heating"] },
      { dest: "Panaji", minPrice: 5000, maxPrice: 1200, guests: 7, type: ["cabin"], amenities: ["pool", "heating"] },
    );
    const out = await suggestForEmptyResults({ Listing: fakeListing(), parsed });
    expect(out.filterSuggestions.length).toBeLessThanOrEqual(MAX_FILTER_SUGGESTIONS);
    const counts = out.filterSuggestions.map((s) => s.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  test("a filter whose removal still gives zero is never offered", async () => {
    // Nothing has a pool AND a price under 1000: dropping the price leaves one match, dropping the pool leaves one.
    // Dropping the destination alone leaves zero, so it must not appear.
    const parsed = parsedFrom(
      { destination: "Manali", amenities: ["pool"], maxPrice: 900 },
      { dest: "Manali", amenities: ["pool"], maxPrice: 900 },
    );
    const Listing = fakeListing();
    const out = await suggestForEmptyResults({ Listing, parsed });
    for (const s of out.filterSuggestions) expect(s.count).toBeGreaterThan(0);
    expect(out.filterSuggestions.find((s) => s.key === "destination")).toBeUndefined();
  });

  test("every offered link, applied to the data, really has results", async () => {
    const searches = [
      { searchParams: { destination: "Panaji", guests: 9 }, state: { dest: "Panaji", guests: 9 } },
      { searchParams: { amenities: ["pool"], maxPrice: 900 }, state: { amenities: ["pool"], maxPrice: 900 } },
      { searchParams: { destination: "Manali", propertyType: ["villa"], guests: 6 }, state: { dest: "Manali", type: ["villa"], guests: 6 } },
      { searchParams: { guests: 12 }, state: { guests: 12 } },
    ];
    for (const s of searches) {
      const Listing = fakeListing();
      const out = await suggestForEmptyResults({ Listing, parsed: parsedFrom(s.searchParams, s.state) });
      for (const item of out.filterSuggestions) {
        // Re-derive the parameters from the URL and count again with the same fake.
        const url = new URL(item.url, "http://x");
        const searchParams = { ...s.searchParams };
        const dropped = { dates: [], amenities: ["amenities"], price: ["minPrice", "maxPrice"], type: ["propertyType"], guests: ["guests"], destination: ["destination"] }[item.key];
        for (const k of dropped) delete searchParams[k];
        const n = (await fakeListing().countDocuments(buildFilter(searchParams)));
        expect(n).toBe(item.count);
        expect(n).toBeGreaterThan(0);
        expect(url.pathname).toBe("/listings");
      }
    }
  });

  test("nothing is offered when no single filter is the cause", async () => {
    const parsed = parsedFrom({ destination: "Nowhere" }, { dest: "Nowhere" });
    const out = await suggestForEmptyResults({ Listing: fakeListing([]), parsed });
    expect(out.filterSuggestions).toEqual([]);
    expect(out.destinations).toEqual([]);
    expect(out.hasAnyStays).toBe(false);
  });
});

describe("dates", () => {
  const STAY = { checkIn: new Date(Date.UTC(2026, 10, 12)), checkOut: new Date(Date.UTC(2026, 10, 15)) };

  test("dropping the dates removes the ledger exclusion; other drops keep it", async () => {
    const parsed = parsedFrom({ destination: "Panaji", guests: 9 }, { dest: "Panaji", in: "2026-11-12", out: "2026-11-15", guests: 9 }, STAY);
    const Listing = fakeListing();
    const out = await suggestForEmptyResults({ Listing, parsed, takenIds: ["a", "d"] });
    const dates = out.filterSuggestions.find((s) => s.key === "dates");
    // Without the dates, Panaji has a and d, but guests 9 still leaves 0, so the dates are not offered.
    expect(dates).toBeUndefined();
    const parsed2 = parsedFrom({ destination: "Panaji" }, { dest: "Panaji", in: "2026-11-12", out: "2026-11-15" }, STAY);
    const out2 = await suggestForEmptyResults({ Listing: fakeListing(), parsed: parsed2, takenIds: ["a", "d"] });
    const d2 = out2.filterSuggestions.find((s) => s.key === "dates");
    expect(d2.count).toBe(2);
    expect(d2.label).toBe("Remove the dates (2026-11-12 to 2026-11-15)");
    expect(d2.url).toBe("/listings?dest=Panaji");
  });

  test("dropping the destination keeps the dates and the taken listings excluded", async () => {
    const parsed = parsedFrom({ destination: "Panaji" }, { dest: "Panaji", in: "2026-11-12", out: "2026-11-15" }, STAY);
    const out = await suggestForEmptyResults({ Listing: fakeListing(), parsed, takenIds: ["a", "b", "c", "d"] });
    expect(out.filterSuggestions.find((s) => s.key === "destination")).toBeUndefined(); // all four are taken: still 0
  });
});

describe("the query budget", () => {
  test("at most 5 queries, even with every filter active", async () => {
    const searchParams = {
      destination: "Panaji", keywords: "sea", minPrice: 1, maxPrice: 2, guests: 2, bedrooms: 1,
      propertyType: ["villa"], roomType: ["entire_place"], amenities: ["wifi"], instantBook: true,
    };
    const parsed = parsedFrom(searchParams, { dest: "Panaji", in: "2026-11-12", out: "2026-11-15" }, { checkIn: new Date(), checkOut: new Date() });
    const Listing = fakeListing();
    const out = await suggestForEmptyResults({ Listing, parsed });
    expect(Listing.calls.counts + Listing.calls.finds).toBeLessThanOrEqual(MAX_EXTRA_QUERIES);
    expect(Listing.calls.counts).toBe(4);
    expect(Listing.calls.finds).toBe(1);
    expect(out.queries).toBe(5);
    expect(MAX_EXTRA_QUERIES).toBe(5);
  });

  test("one active filter: one count and one destination query", async () => {
    const Listing = fakeListing();
    await suggestForEmptyResults({ Listing, parsed: parsedFrom({ guests: 20 }, { guests: 20 }) });
    expect(Listing.calls.counts).toBe(1);
    expect(Listing.calls.finds).toBe(1);
  });

  test("no active filter group: only the destinations are looked up", async () => {
    const Listing = fakeListing();
    await suggestForEmptyResults({ Listing, parsed: parsedFrom({}, {}) });
    expect(Listing.calls.counts).toBe(0);
    expect(Listing.calls.finds).toBe(1);
  });

  test("every group has the pieces the service needs", () => {
    for (const g of GROUPS) {
      expect(typeof g.key).toBe("string");
      expect(Array.isArray(g.urlKeys)).toBe(true);
      expect(Array.isArray(g.serviceKeys)).toBe(true);
      expect(typeof g.active).toBe("function");
      expect(typeof g.label).toBe("function");
    }
    expect(new Set(GROUPS.map((g) => g.key)).size).toBe(GROUPS.length);
  });
});

describe("popular destinations", () => {
  test("the busiest cities first, each with a link to that city alone", async () => {
    const out = await suggestForEmptyResults({ Listing: fakeListing(), parsed: parsedFrom({ guests: 20 }, { guests: 20 }) });
    expect(out.destinations.map((d) => [d.label, d.count])).toEqual([["Panaji", 2], ["Manali", 1], ["Margao", 1]]);
    expect(out.destinations[0].url).toBe("/listings?dest=Panaji");
    expect(out.hasAnyStays).toBe(true);
  });

  test("a destination link finds the destination it is for (never a dead end)", async () => {
    const tricky = [
      { _id: "x", cityKey: "sao paulo", address: { city: "São Paulo" } },
      { _id: "y", cityKey: "st john s", address: { city: "St. John's" } },
      { _id: "z", cityKey: "pune", address: { city: "" }, location: "" },
      { _id: "w", cityKey: "delhi", address: { city: "Delhi, NCR" } },
    ];
    const destinations = await popularDestinations(fakeListing(tricky));
    for (const d of destinations) {
      const parts = destinationParts(d.dest);
      expect(parts).toHaveLength(1);
      const hits = tricky.filter((s) => s.cityKey.startsWith(parts[0]));
      expect(hits.length).toBeGreaterThan(0);
    }
    expect(destinations.map((d) => d.dest).sort()).toEqual(["Delhi", "St. John's", "pune", "São Paulo"].sort());
  });

  test("listings without a city key, and a result that is not a list, are skipped", async () => {
    expect(await popularDestinations(fakeListing([{ _id: "n", address: { city: "X" } }]))).toEqual([]);
    const odd = { find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => null }) }) }) }) };
    expect(await popularDestinations(odd)).toEqual([]);
  });

  test("at most six destinations", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ _id: `m${i}`, cityKey: `city ${String.fromCharCode(97 + i)}`, address: { city: `City ${String.fromCharCode(65 + i)}` } }));
    expect(await popularDestinations(fakeListing(many))).toHaveLength(6);
  });
});
