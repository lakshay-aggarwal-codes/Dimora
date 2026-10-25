// P15-T02: what the public page shows from stored nearby places. Pure data, no network.
const { neighborhoodFor, roundDistance, distanceLabel } = require("../../src/services/neighborhood");

const FETCHED = new Date("2026-10-25T06:00:00Z");
const item = (category, distanceM, name = "Place", kind = "cafe") => ({ category, name, kind, distanceM });
const listing = (items, extra = {}) => ({
  nearby: { fetchedAt: FETCHED, source: "OpenStreetMap contributors", items, ...extra },
});

describe("rounding and labels", () => {
  test("distances go to the nearest 50 m, never below 50", () => {
    expect(roundDistance(0)).toBe(50);
    expect(roundDistance(20)).toBe(50);
    expect(roundDistance(120)).toBe(100);
    expect(roundDistance(130)).toBe(150);
    expect(roundDistance(640)).toBe(650);
    expect(roundDistance(1240)).toBe(1250);
  });

  test("label says straight-line; kilometres from 1000 m", () => {
    expect(distanceLabel(650)).toBe("\u2248 650 m straight-line");
    expect(distanceLabel(950)).toBe("\u2248 950 m straight-line");
    expect(distanceLabel(1000)).toBe("\u2248 1.0 km straight-line");
    expect(distanceLabel(1250)).toBe("\u2248 1.3 km straight-line");
  });
});

describe("neighborhoodFor", () => {
  test("nothing stored, or nothing usable, hides the whole section (null)", () => {
    expect(neighborhoodFor(null)).toBe(null);
    expect(neighborhoodFor({})).toBe(null);
    expect(neighborhoodFor({ nearby: { items: [] } })).toBe(null); // never fetched
    expect(neighborhoodFor(listing([]))).toBe(null); // fetched, nothing around
    expect(neighborhoodFor(listing([item("unknown-category", 100), item("food", NaN), item("food", -5)]))).toBe(null);
  });

  test("only categories with places become tabs, in the fixed order, nearest first, distances rounded", () => {
    const view = neighborhoodFor(
      listing([item("park", 900, "Park"), item("food", 640, "Far"), item("food", 120, "Near"), item("food", 125, null, "fast_food")]),
    );
    expect(view.categories.map((c) => c.id)).toEqual(["food", "park"]);
    const food = view.categories[0];
    expect(food.items.map((i) => i.name)).toEqual(["Near", null, "Far"]);
    expect(food.items.map((i) => i.distanceM)).toEqual([100, 150, 650]);
    expect(food.items[1].kindLabel).toBe("fast food");
    expect(food.items[2].distanceLabel).toBe("\u2248 650 m straight-line");
    expect(food.nearestM).toBe(100);
    expect(view.fetchedOn).toBe("2026-10-25");
    expect(view.source).toBe("OpenStreetMap contributors");
  });

  test("the map layer is one radius per category and carries no position", () => {
    const view = neighborhoodFor(listing([item("food", 640), item("transit", 1240, "Station", "station")]));
    expect(view.rings).toEqual([
      { id: "food", label: "Food and drink", radiusM: 650 },
      { id: "transit", label: "Public transport", radiusM: 1250 },
    ]);
    const text = JSON.stringify(view);
    for (const key of ["lat", "lng", "lon", "coordinates", "geometry"]) {
      expect(text.includes(`"${key}"`)).toBe(false);
    }
  });

  test("a stored item with extra fields (a future coordinate, say) never reaches the page data", () => {
    const sneaky = { ...item("food", 300), lat: 15.5, lon: 73.8, osmId: 7 };
    const text = JSON.stringify(neighborhoodFor(listing([sneaky])));
    expect(text.includes("15.5")).toBe(false);
    expect(text.includes("73.8")).toBe(false);
    expect(text.includes("osmId")).toBe(false);
  });
});
