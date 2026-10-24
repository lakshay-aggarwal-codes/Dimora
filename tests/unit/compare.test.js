// P10-T03: the comparison rules against fakes (no database, no network).
const { ObjectId } = require("mongoose").Types;
const { parseCompareQuery } = require("../../src/validation/compareQuery");
const {
  compare,
  amenityMatrix,
  compareUrl,
  distanceLabel,
} = require("../../src/services/compare");
const { getQuote } = require("../../src/services/quoteService");

const NOW = new Date("2026-10-25T06:00:00Z");
const hex = () => String(new ObjectId());
const noneTaken = { unavailableDates: async () => [] };
const realQuote = (listing, query, options) =>
  getQuote(listing, query, { ...options, ledgerService: noneTaken });

function stay(extra = {}) {
  return {
    _id: new ObjectId(),
    title: "Sea house",
    status: "published",
    location: "Goa",
    country: "India",
    pricing: { nightlyMinor: 500000, cleaningFeeMinor: 100000, currency: "INR" },
    capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
    amenities: ["wifi", "kitchen"],
    cancellationPolicy: "flexible",
    houseRules: "No parties",
    ratingAvg: 4.5,
    ratingCount: 10,
    minNights: 1,
    maxNights: 30,
    ...extra,
  };
}

function deps(listings, extra = {}) {
  return {
    Listing: {
      find: (filter) => ({
        lean: async () =>
          listings.filter((l) => filter._id.$in.includes(String(l._id))),
      }),
    },
    getQuote: realQuote,
    publicPointOf: (l) => l.point || null,
    distanceMeters: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat) * 111000,
    LocationNotFoundError: class extends Error {},
    GeocoderUnavailableError: class extends Error {},
    lookupPlace: async () => ({ point: { lng: 0, lat: 0 }, name: "Station" }),
    ...extra,
  };
}
const ids = (list) => list.map((l) => String(l._id));
const q = (list, more = {}) => ({ ids: ids(list).join(","), ...more });
const fails = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
};

describe("parseCompareQuery", () => {
  test("accepts 2 to 4 ids as a comma list, repeated parameters, or both; duplicates count once", () => {
    const [a, b, c] = [hex(), hex(), hex()];
    expect(parseCompareQuery({ ids: `${a},${b}` }).ids).toEqual([a, b]);
    expect(parseCompareQuery({ ids: [a, b, c] }).ids).toEqual([a, b, c]);
    expect(parseCompareQuery({ ids: [`${a},${b}`, b, c] }).ids).toEqual([a, b, c]);
  });

  test("5 or more ids, fewer than 2, or a bad id is a 400", () => {
    const five = Array.from({ length: 5 }, hex).join(",");
    for (const bad of [five, hex(), "", undefined, "nope,also-nope", { x: "y" }]) {
      let err;
      try {
        parseCompareQuery({ ids: bad });
      } catch (e) {
        err = e;
      }
      expect(err.statusCode).toBe(400);
    }
  });

  test("dates: none is fine, one alone or a bad one is a 400 with the field named", () => {
    const base = { ids: `${hex()},${hex()}` };
    expect(parseCompareQuery(base).dates).toBe(null);
    expect(parseCompareQuery({ ...base, in: "", out: "" }).dates).toBe(null);
    const ok = parseCompareQuery({ ...base, in: "2026-12-01", out: "2026-12-04", guests: "2" });
    expect(ok.dates.guests).toBe(2);
    for (const more of [{ in: "2026-12-01" }, { in: "01/12/2026", out: "2026-12-04" }]) {
      let err;
      try {
        parseCompareQuery({ ...base, ...more });
      } catch (e) {
        err = e;
      }
      expect(err.statusCode).toBe(400);
    }
  });
});

describe("amenityMatrix", () => {
  const col = (id, amenities, available = true) => ({ id, available, amenities });

  test("marks an amenity that only one stay has, and one that all have", () => {
    const rows = amenityMatrix([
      col("a", ["wifi", "pool"]),
      col("b", ["wifi"]),
      col("c", ["wifi", "kitchen"]),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.value, r]));
    expect(by.wifi.inAll).toBe(true);
    expect(by.wifi.onlyId).toBe(null);
    expect(by.pool.onlyId).toBe("a");
    expect(by.pool.has).toEqual([true, false, false]);
    expect(by.kitchen.onlyId).toBe("c");
    expect(by.gym).toBe(undefined); // nobody has it: no row
  });

  test("an unavailable column never counts and never gets a tick", () => {
    const rows = amenityMatrix([col("a", ["pool"]), col("b", ["pool"], false)]);
    expect(rows[0].has).toEqual([true, false]);
    expect(rows[0].onlyId).toBe(null); // only one public stay: nothing to compare against
  });
});

describe("compare()", () => {
  test("with dates, each total is exactly what the quote service returns", async () => {
    const [a, b] = [stay(), stay({ pricing: { nightlyMinor: 800000, currency: "INR" } })];
    const query = { in: "2026-12-01", out: "2026-12-04", guests: "2" };
    const result = await compare({ query: q([a, b], query), now: NOW, deps: deps([a, b]) });
    for (const [column, listing] of [[result.columns[0], a], [result.columns[1], b]]) {
      const direct = await realQuote(listing, query, { now: NOW });
      expect(column.quote.state).toBe("total");
      expect(column.quote.totalMinor).toBe(direct.quote.totalMinor);
      expect(column.quote.avgPerNightMinor).toBe(direct.quote.avgPerNightMinor);
    }
    expect(result.cheapestId).toBe(String(a._id));
  });

  test("without dates: nightly prices only, no quote is asked for", async () => {
    const [a, b] = [stay(), stay()];
    let asked = 0;
    const result = await compare({
      query: q([a, b]),
      now: NOW,
      deps: deps([a, b], { getQuote: async () => { asked++; } }),
    });
    expect(asked).toBe(0);
    expect(result.dates).toBe(null);
    expect(result.columns[0].nightlyMinor).toBe(500000);
    expect(result.columns[0].quote.state).toBe("none");
  });

  test("a stay that is not public becomes a bare unavailable column (no title), the rest still compare", async () => {
    const [a, b] = [stay(), stay({ status: "draft", title: "Secret draft" })];
    const missing = hex();
    const result = await compare({
      query: { ids: `${String(a._id)},${String(b._id)},${missing}`, in: "2026-12-01", out: "2026-12-04" },
      now: NOW,
      deps: deps([a, b]),
    });
    expect(result.columns.map((c) => c.available)).toEqual([true, false, false]);
    expect(JSON.stringify(result.columns[1]).includes("Secret draft")).toBe(false);
    expect(result.columns[0].quote.state).toBe("total");
  });

  test("mixed currencies are blocked with a message", async () => {
    const [a, b] = [stay(), stay({ pricing: { nightlyMinor: 9000, currency: "USD" } })];
    const result = await compare({ query: q([a, b]), now: NOW, deps: deps([a, b]) });
    expect(typeof result.blocked).toBe("string");
  });

  test("a stay the rules refuse shows the reason, not a price", async () => {
    const [a, b] = [stay(), stay({ capacity: { guests: 1 } })];
    const result = await compare({
      query: q([a, b], { in: "2026-12-01", out: "2026-12-04", guests: "3" }),
      now: NOW,
      deps: deps([a, b]),
    });
    expect(result.columns[0].quote.state).toBe("total");
    expect(result.columns[1].quote.state).toBe("unavailable"); // sleeps 1, 3 guests asked
    expect(result.columns[1].quote.note.length > 0).toBe(true);
    expect(result.cheapestId).toBe(null);
  });

  test("distance to a place: labelled per stay; an unknown place is a note, not an error", async () => {
    const [a, b] = [stay({ point: { lng: 0.01, lat: 0 } }), stay()]; // b has no point
    const found = await compare({ query: q([a, b], { place: "Station" }), now: NOW, deps: deps([a, b]) });
    expect(found.place.name).toBe("Station");
    expect(found.columns[0].distance).toBe("about 1.1 km");
    expect(found.columns[1].distance).toBe("");

    const d = deps([a, b]);
    d.lookupPlace = async () => { throw new d.LocationNotFoundError(); };
    const missed = await compare({ query: q([a, b], { place: "Nowhere" }), now: NOW, deps: d });
    expect(missed.place.note.length > 0).toBe(true);

    const e = deps([a, b]);
    e.lookupPlace = async () => { throw new Error("boom"); };
    expect((await fails(compare({ query: q([a, b], { place: "x" }), now: NOW, deps: e }))).message).toBe("boom");
  });

  test("remove links keep dates and place, and exist only above 2 stays", async () => {
    const list = [stay(), stay(), stay()];
    const result = await compare({
      query: q(list, { in: "2026-12-01", out: "2026-12-04", guests: "2" }),
      now: NOW,
      deps: deps(list),
    });
    expect(result.removable).toBe(true);
    const link = result.removeHref[String(list[0]._id)];
    expect(link.includes(String(list[0]._id))).toBe(false);
    expect(link.includes("in=2026-12-01")).toBe(true);
    const two = await compare({ query: q(list.slice(0, 2)), now: NOW, deps: deps(list) });
    expect(two.removable).toBe(false);
  });
});

describe("helpers", () => {
  test("distanceLabel", () => {
    expect(distanceLabel(640)).toBe("about 640 m");
    expect(distanceLabel(1449)).toBe("about 1.4 km");
    expect(distanceLabel(NaN)).toBe("");
  });
  test("compareUrl", () => {
    expect(compareUrl({ ids: ["a", "b"], dates: null, place: "" })).toBe("/compare?ids=a%2Cb");
  });
});
