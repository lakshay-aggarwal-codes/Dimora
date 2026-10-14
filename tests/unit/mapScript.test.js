// public/js/map.js runs in a browser. Here it runs in a Node vm with a tiny
// fake document and a fake Mapbox GL, so no browser or jsdom is needed.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "map.js"),
  "utf8",
);

function makeElement(tag = "div") {
  return {
    tag,
    textContent: "",
    children: [],
    classes: new Set(),
    dataset: {},
    classList: { add(name) { this.owner.classes.add(name); } },
    append(...nodes) { this.children.push(...nodes); },
  };
}

function run({ dataset, withMapbox = true, mapThrows = false } = {}) {
  const calls = { map: null, marker: null, lngLat: null, popup: null, content: null };
  const mapEl = makeElement();
  mapEl.dataset = dataset || {};
  mapEl.classList.owner = mapEl;

  const document = {
    getElementById: (id) => (id === "map" && dataset ? mapEl : null),
    createElement: (tag) => {
      const el = makeElement(tag);
      el.classList.owner = el;
      return el;
    },
  };

  const mapboxgl = {
    Map: function (options) {
      if (mapThrows) throw new Error("invalid token");
      calls.map = options;
    },
    Marker: function (options) {
      calls.marker = options;
      this.setLngLat = (value) => { calls.lngLat = value; return this; };
      this.setPopup = (popup) => { calls.popup = popup; return this; };
      this.addTo = () => this;
    },
    Popup: function (options) {
      this.options = options;
      this.setDOMContent = (node) => { calls.content = node; return this; };
      this.setHTML = () => { throw new Error("setHTML must not be used"); };
    },
  };

  const errors = [];
  const sandbox = {
    document,
    console: { error: (...args) => errors.push(args) },
  };
  if (withMapbox) sandbox.mapboxgl = mapboxgl;
  vm.runInNewContext(SOURCE, sandbox);
  return { calls, mapEl, errors };
}

const VALID = { token: "pk.x", lng: "77.209", lat: "28.6139", title: "Seaside Cottage" };

test("does nothing when the page has no #map", () => {
  const { calls } = run({ dataset: null });
  expect(calls.map).toBeNull();
});

test("builds the map and marker from the data- attributes", () => {
  const { calls, mapEl } = run({ dataset: VALID });
  expect(calls.map.accessToken).toBe("pk.x");
  expect(calls.map.container).toBe(mapEl);
  expect(calls.map.center).toEqual([77.209, 28.6139]);
  expect(calls.lngLat).toEqual([77.209, 28.6139]);
});

test("the title goes into the popup as text, never as HTML", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { calls } = run({ dataset: { ...VALID, title: evil } });
  const [heading] = calls.content.children;
  expect(heading.tag).toBe("h4");
  expect(heading.textContent).toBe(evil);
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
});

test("shows a message when Mapbox GL did not load or the token is missing", () => {
  const noLib = run({ dataset: VALID, withMapbox: false });
  expect(noLib.mapEl.textContent).toMatch(/could not be loaded/);
  const noToken = run({ dataset: { ...VALID, token: "" } });
  expect(noToken.calls.map).toBeNull();
  expect(noToken.mapEl.textContent).toMatch(/could not be loaded/);
});

test("a Mapbox error (e.g. an invalid token) is caught and reported", () => {
  const { mapEl, errors } = run({ dataset: VALID, mapThrows: true });
  expect(mapEl.textContent).toMatch(/could not be loaded/);
  expect(errors).toHaveLength(1);
});
