// P15-T03: the nearest-transit and nearest-grocery rows of the comparison,
// from stored nearby data (no database, no network).
const { ObjectId } = require("mongoose").Types;
const { compare, nearbyFor, nearbySection } = require("../../src/services/compare");
const { getQuote } = require("../../src/services/quoteService");

const NOW = new Date("2026-10-25T06:00:00Z");
const FETCHED = new Date("2026-10-20T06:00:00Z");
const noneTaken = { unavailableDates: async () => [] };
const item = (category, distanceM, name, kind) => ({ category, distanceM, name, kind });

function stay(extra = {}) {
  return {
    _id: new ObjectId(),
    title: "Sea house",
    status: "published",
    location: "Goa",
    country: "India",
    pricing: { nightlyMinor: 500000, cleaningFeeMinor: 100000, currency: "INR" },
    capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
    amenities: ["wifi"],
    cancellationPolicy: "flexible",
    minNights: 1,
    maxNights: 30,
    ...extra,
  };
}
const withNearby = (items, extra = {}) => ({
  nearby: { fetchedAt: FETCHED, source: "OpenStreetMap contributors", items, ...extra },
});

function deps(listings) {
  return {
    Listing: { find: (f) => ({ lean: async () => listings.filter((l) => f._id.$in.includes(String(l._id))) }) },
    getQuote: (l, q, o) => getQuote(l, q, { ...o, ledgerService: noneTaken }),
    publicPointOf: () => null,
    distanceMeters: () => 0,
    LocationNotFoundError: class extends Error {},
    GeocoderUnavailableError: class extends Error {},
    lookupPlace: async () => ({ point: { lng: 0, lat: 0 }, name: "x" }),
  };
}
const run = (listings) =>
  compare({ query: { ids: listings.map((l) => String(l._id)).join(",") }, now: NOW, deps: deps(listings) });

describe("nearbyFor", () => {
  test("nothing stored: null", () => {
    expect(nearbyFor(stay())).toBeNull();
    expect(nearbyFor(stay({ nearby: { items: [] } }))).toBeNull();
    expect(nearbyFor(stay(withNearby([])))).toBeNull();
  });

  test("takes the nearest of each category, rounded to 50 m, from the stored distances", () => {
    const l = stay(withNearby([
      item("transit", 1320, "Far Stop", "bus_stop"),
      item("transit", 430, "Central Station", "station"),
      item("grocery", 660, null, "convenience"),
      item("food", 90, "Cafe", "cafe"),
    ]));
    const n = nearbyFor(l);
    expect(n.fetchedOn).toBe("2026-10-20");
    expect(n.transit).toEqual({ name: "Central Station", kindLabel: "station", distanceLabel: "\u2248 450 m straight-line" });
    expect(n.grocery).toEqual({ name: null, kindLabel: "convenience", distanceLabel: "\u2248 650 m straight-line" });
  });

  test("fetched but nothing of a category found: that one is null, the other still shows", () => {
    const n = nearbyFor(stay(withNearby([item("grocery", 400, "Mart", "supermarket")])));
    expect(n.transit).toBeNull();
    expect(n.grocery.name).toBe("Mart");
  });

  test("exposes no coordinates and nothing but the whitelisted fields", () => {
    const l = stay(withNearby([{ ...item("transit", 400, "Stop", "bus_stop"), lat: 1, lng: 2, osmId: 9 }]));
    const n = nearbyFor(l);
    expect(Object.keys(n.transit).sort()).toEqual(["distanceLabel", "kindLabel", "name"]);
    expect(JSON.stringify(n)).not.toMatch(/"lat"|"lng"|osmId/);
  });
});

describe("nearbySection", () => {
  const col = (nearby, available = true) => ({ available, nearby });

  test("null when no live stay has data", () => {
    expect(nearbySection([col(null), col(null, false)])).toBeNull();
    expect(nearbySection([{ available: false, nearby: { fetchedOn: "2026-01-01" } }])).toBeNull();
  });

  test("two rows, the source, and the oldest and newest fetch dates of the live stays", () => {
    const s = nearbySection([col({ fetchedOn: "2026-10-25" }), col({ fetchedOn: "2026-10-20" }), col(null)]);
    expect(s.rows.map((r) => r.id)).toEqual(["transit", "grocery"]);
    expect(s.source).toBe("OpenStreetMap contributors");
    expect([s.from, s.to]).toEqual(["2026-10-20", "2026-10-25"]);
  });
});

describe("compare() with nearby data", () => {
  test("columns carry their rows and the result carries the section", async () => {
    const a = stay(withNearby([item("transit", 300, "Stop A", "bus_stop"), item("grocery", 800, "Mart", "supermarket")]));
    const b = stay();
    const result = await run([a, b]);
    expect(result.columns[0].nearby.transit.name).toBe("Stop A");
    expect(result.columns[1].nearby).toBeNull();
    expect(result.nearby.rows).toHaveLength(2);
  });

  test("no stay has data: no section", async () => {
    const result = await run([stay(), stay()]);
    expect(result.nearby).toBeNull();
  });

  test("a stay that is not public contributes no nearby data", async () => {
    const hidden = stay({ status: "suspended", ...withNearby([item("transit", 100, "Secret Stop", "bus_stop")]) });
    const result = await run([hidden, stay()]);
    expect(result.nearby).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Secret Stop");
  });

  test("works with dates too (the quote is unchanged by the extra rows)", async () => {
    const a = stay(withNearby([item("transit", 300, "Stop A", "bus_stop")]));
    const b = stay();
    const result = await compare({
      query: { ids: [a, b].map((l) => String(l._id)).join(","), in: "2026-11-10", out: "2026-11-12", guests: "2" },
      now: NOW,
      deps: deps([a, b]),
    });
    expect(result.columns[0].quote.state).toBe("total");
    expect(result.nearby).not.toBeNull();
  });

  test("different currencies: blocked, no nearby section", async () => {
    const a = stay(withNearby([item("transit", 300, "Stop A", "bus_stop")]));
    const b = stay({ pricing: { nightlyMinor: 500000, currency: "USD" } });
    const result = await run([a, b]);
    expect(result.blocked).toBeTruthy();
    expect(result.nearby).toBeNull();
  });
});
