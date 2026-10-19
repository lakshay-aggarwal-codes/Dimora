// public/js/map.js runs in a browser. Here it runs in a Node vm with a tiny
// fake document and a fake Mapbox GL, so no browser or jsdom is needed.
// P06-T03: the map draws a circle for the approximate area, never a pin.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { distanceMeters, MAX_OFFSET_M, PUBLIC_AREA_RADIUS_M } = require("../../src/utils/geo");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "map.js"),
  "utf8",
);

function makeElement(initialText = "") {
  const el = {
    textContent: initialText,
    classes: new Set(),
    attributes: {},
    dataset: {},
    classList: { add(name) { el.classes.add(name); } },
    setAttribute(name, value) { el.attributes[name] = value; },
  };
  return el;
}

function run({ dataset, withMapbox = true, mapThrows = false, fallback = "Approximate area: Goa, India." } = {}) {
  const calls = { map: null, controls: [], sources: {}, layers: [], handlers: {}, removed: false, timers: [] };
  const mapEl = makeElement(fallback);
  mapEl.dataset = dataset || {};

  const document = { getElementById: (id) => (id === "map" && dataset ? mapEl : null) };

  const mapboxgl = {
    Map: function (options) {
      if (mapThrows) throw new Error("invalid token");
      calls.map = options;
      this.on = (name, fn) => { calls.handlers[name] = fn; };
      this.addControl = (control, position) => calls.controls.push({ control, position });
      this.addSource = (id, source) => { calls.sources[id] = source; };
      this.addLayer = (layer) => calls.layers.push(layer);
      this.remove = () => { calls.removed = true; };
    },
    NavigationControl: function (options) { this.options = options; },
    // Pins and popups must never be used: the page shows an area, not an address.
    Marker: function () { throw new Error("Marker must not be used"); },
    Popup: function () { throw new Error("Popup must not be used"); },
  };

  const errors = [];
  const sandbox = {
    document,
    console: { error: (...args) => errors.push(args) },
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
  };
  if (withMapbox) sandbox.mapboxgl = mapboxgl;
  vm.runInNewContext(SOURCE, sandbox);
  return { calls, mapEl, errors };
}

const VALID = { token: "pk.x", lng: "77.209", lat: "28.6139", radius: "1000", title: "Seaside Cottage" };

test("does nothing when the page has no #map", () => {
  const { calls } = run({ dataset: null });
  expect(calls.map).toBeNull();
});

test("builds the map around the public point and fits the circle", () => {
  const { calls, mapEl } = run({ dataset: VALID });
  expect(calls.map.accessToken).toBe("pk.x");
  expect(calls.map.container).toBe(mapEl);
  expect(calls.map.center).toEqual([77.209, 28.6139]);
  const [[minLng, minLat], [maxLng, maxLat]] = calls.map.bounds;
  expect(minLng).toBeLessThan(77.209);
  expect(maxLng).toBeGreaterThan(77.209);
  expect(minLat).toBeLessThan(28.6139);
  expect(maxLat).toBeGreaterThan(28.6139);
});

test("adds zoom buttons and a label that names the listing as text", () => {
  const { calls, mapEl } = run({ dataset: { ...VALID, title: '<img src=x onerror="alert(1)">' } });
  expect(calls.controls).toHaveLength(1);
  expect(calls.controls[0].control.options).toEqual({ showCompass: false });
  expect(mapEl.attributes["aria-label"]).toBe('Approximate area map for <img src=x onerror="alert(1)">');
});

test("on load it draws one polygon whose edge is the given radius from the centre", () => {
  const { calls } = run({ dataset: VALID });
  calls.handlers.load();
  const source = calls.sources["approximate-area"];
  expect(source.data.geometry.type).toBe("Polygon");
  const ring = source.data.geometry.coordinates[0];
  expect(ring.length).toBeGreaterThan(30);
  expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
  for (const [lng, lat] of ring) {
    const d = distanceMeters({ lng: 77.209, lat: 28.6139 }, { lng, lat });
    expect(Math.abs(d - 1000)).toBeLessThan(2);
  }
  expect(calls.layers.map((l) => l.type)).toEqual(["fill", "line"]);
  expect(calls.layers.every((l) => l.source === "approximate-area")).toBe(true);
});

test("the radius always covers the real home: public radius is larger than the maximum offset", () => {
  expect(PUBLIC_AREA_RADIUS_M).toBeGreaterThan(MAX_OFFSET_M);
});

test("a missing or absurd radius falls back to 1000 m", () => {
  for (const radius of [undefined, "", "abc", "5", "999999"]) {
    const { calls } = run({ dataset: { ...VALID, radius } });
    calls.handlers.load();
    const ring = calls.sources["approximate-area"].data.geometry.coordinates[0];
    const d = distanceMeters({ lng: 77.209, lat: 28.6139 }, { lng: ring[0][0], lat: ring[0][1] });
    expect(Math.abs(d - 1000)).toBeLessThan(2);
  }
});

test("a circle across the antimeridian stays one continuous ring", () => {
  const { calls } = run({ dataset: { ...VALID, lng: "179.999", lat: "-16.5" } });
  calls.handlers.load();
  const ring = calls.sources["approximate-area"].data.geometry.coordinates[0];
  for (let i = 1; i < ring.length; i += 1) {
    expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(1);
  }
});

test.each([
  ["missing longitude", { ...VALID, lng: undefined }],
  ["empty latitude", { ...VALID, lat: "" }],
  ["non-numeric longitude", { ...VALID, lng: "abc" }],
  ["longitude out of range", { ...VALID, lng: "181" }],
  ["latitude out of range", { ...VALID, lat: "-91" }],
])("shows a message instead of a map for %s", (_name, dataset) => {
  const { calls, mapEl } = run({ dataset });
  expect(calls.map).toBeNull();
  expect(mapEl.textContent).toMatch(/not available/);
  expect(mapEl.classes.has("map-unavailable")).toBe(true);
});

test("shows a message when Mapbox GL did not load or the token is missing, keeping the area text", () => {
  const noLib = run({ dataset: VALID, withMapbox: false });
  expect(noLib.mapEl.textContent).toMatch(/could not be loaded/);
  expect(noLib.mapEl.textContent).toContain("Approximate area: Goa, India.");
  const noToken = run({ dataset: { ...VALID, token: "" } });
  expect(noToken.calls.map).toBeNull();
  expect(noToken.mapEl.textContent).toMatch(/could not be loaded/);
});

test("a Mapbox error (e.g. an invalid token) is caught and the text fallback comes back", () => {
  const { mapEl, errors } = run({ dataset: VALID, mapThrows: true });
  expect(mapEl.textContent).toMatch(/could not be loaded/);
  expect(mapEl.textContent).toContain("Approximate area: Goa, India.");
  expect(errors).toHaveLength(1);
});

test("an error event before the map loaded (offline, bad token) removes the map and shows the text", () => {
  const { calls, mapEl } = run({ dataset: VALID });
  calls.handlers.error({ error: new Error("offline") });
  expect(calls.removed).toBe(true);
  expect(mapEl.textContent).toMatch(/could not be loaded/);
  expect(mapEl.textContent).toContain("Approximate area: Goa, India.");
});

test("an error after the map loaded (one failed tile) is ignored", () => {
  const { calls, mapEl } = run({ dataset: VALID });
  calls.handlers.load();
  calls.handlers.error({ error: new Error("tile 404") });
  expect(calls.removed).toBe(false);
  expect(mapEl.classes.has("map-unavailable")).toBe(false);
});

test("a map that never loads falls back after the timeout; a loaded one does not", () => {
  const stuck = run({ dataset: VALID });
  expect(stuck.calls.timers).toHaveLength(1);
  stuck.calls.timers[0].fn();
  expect(stuck.mapEl.textContent).toMatch(/could not be loaded/);

  const ok = run({ dataset: VALID });
  ok.calls.handlers.load();
  ok.calls.timers[0].fn();
  expect(ok.mapEl.classes.has("map-unavailable")).toBe(false);
});

test("never creates a pin or a popup", () => {
  // Marker and Popup throw in the fake: a clean run proves neither was constructed.
  const { calls, errors } = run({ dataset: VALID });
  calls.handlers.load();
  expect(errors).toHaveLength(0);
});
