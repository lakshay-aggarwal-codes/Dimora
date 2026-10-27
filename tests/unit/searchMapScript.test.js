// public/js/searchMap.js runs in a browser. Here it runs in a Node vm with a
// tiny fake document, fake Mapbox GL and a fake fetch (no browser, no jsdom).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "searchMap.js"), "utf8");

function makeEl(extra = {}) {
  const el = {
    hidden: false,
    textContent: "",
    dataset: {},
    attributes: {},
    classes: new Set(),
    listeners: {},
    checked: false,
    style: {},
    classList: {
      add: (n) => el.classes.add(n),
      remove: (n) => el.classes.delete(n),
    },
    setAttribute: (n, v) => { el.attributes[n] = v; },
    addEventListener: (name, fn) => { el.listeners[name] = fn; },
    append: (...nodes) => { el.children = (el.children || []).concat(nodes); },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  };
  return el;
}

function setup({ withMapbox = true, token = "pk.x", query = "dest=Goa&guests=2", reduceMotion = null } = {}) {
  const els = {
    "search-map": makeEl({ dataset: { token, endpoint: "/api/search/map", query } }),
    "map-toggle": makeEl({ hidden: true }),
    "search-map-panel": makeEl({ hidden: true }),
    "search-split": makeEl({ dataset: { view: "list" } }),
    results: makeEl(),
    "map-status": makeEl(),
    "map-follow": makeEl(),
    "map-search-area": makeEl({ hidden: true }),
  };
  const cards = { a1: makeEl({ dataset: { listingId: "a1" } }) };
  els.results.querySelector = (sel) => {
    const m = /data-listing-id="([^"]+)"/.exec(sel);
    return m ? cards[m[1]] || null : null;
  };

  const rec = { mapOptions: null, handlers: {}, layerHandlers: {}, layers: [], sources: {}, filters: [], fetches: [], timers: [], easeTo: [], fit: [], resized: 0, popup: null, controls: 0 };
  let bounds = [73, 14, 75, 16];

  function MapFake(options) {
    rec.mapOptions = options;
    this.on = (a, b, c) => {
      if (typeof b === "function") rec.handlers[a] = b;
      else (rec.layerHandlers[a + ":" + b] = c);
    };
    this.addControl = () => { rec.controls += 1; };
    this.addSource = (id, s) => { rec.sources[id] = { ...s, setData: (d) => { rec.sources[id].data = d; }, getClusterExpansionZoom: (cid, cb) => cb(null, 9) }; };
    this.getSource = (id) => rec.sources[id];
    this.addLayer = (l) => rec.layers.push(l);
    this.setFilter = (id, f) => rec.filters.push([id, f]);
    this.getBounds = () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] });
    this.getCanvas = () => ({ style: {} });
    this.easeTo = (o) => rec.easeTo.push(o);
    this.fitBounds = (b, o) => rec.fit.push([b, o]);
    this.resize = () => { rec.resized += 1; };
  }
  function PopupFake(o) { this.o = o; this.setLngLat = (c) => { rec.popupAt = c; return this; }; this.setDOMContent = (n) => { rec.popup = n; return this; }; this.addTo = () => this; this.remove = () => {}; }

  const mapboxgl = { Map: MapFake, NavigationControl: function () { rec.controls += 0; }, Popup: PopupFake };
  const makeResponse = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
  let nextResponse = makeResponse({ type: "FeatureCollection", features: [], meta: { returned: 0, message: "No stays in this area." } });

  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      documentElement: {},
      createElement: () => makeEl(),
    },
    getComputedStyle: () => ({ getPropertyValue: (n) => (n === "--color-primary" ? " teal " : "") }),
    fetch: (url, opts) => { rec.fetches.push({ url, opts }); return Promise.resolve(nextResponse); },
    URLSearchParams,
    AbortController,
    setTimeout: (fn, ms) => { rec.timers.push({ fn, ms }); return rec.timers.length; },
    clearTimeout: () => {},
    console: { error: () => {} },
  };
  if (withMapbox) sandbox.mapboxgl = mapboxgl;
  // P18-T04: the script reads the "reduce motion" preference with matchMedia (a page without it is read as "no preference")
  if (reduceMotion !== null) sandbox.matchMedia = (query) => ({ matches: reduceMotion && /prefers-reduced-motion/.test(query) });
  vm.runInNewContext(SOURCE, sandbox);

  return {
    els, rec, cards,
    setBounds: (b) => { bounds = b; },
    respond: (data, ok) => { nextResponse = makeResponse(data, ok); },
    flush: () => new Promise((r) => setImmediate(r)),
    openMap() { els["map-toggle"].listeners.click(); },
    load: async function () { rec.handlers.load(); await new Promise((r) => setImmediate(r)); },
  };
}

const FC = (features, meta = {}) => ({
  type: "FeatureCollection",
  features,
  meta: { returned: features.length, message: "", ...meta },
});
const feat = (id, lng, lat) => ({ type: "Feature", id, geometry: { type: "Point", coordinates: [lng, lat] }, properties: { id, title: "T" + id, priceLabel: "₹1,000", url: "/listings/" + id } });

describe("searchMap.js", () => {
  test("without Mapbox GL or a token the toggle stays hidden and nothing else happens", () => {
    expect(setup({ withMapbox: false }).els["map-toggle"].hidden).toBe(true);
    const noToken = setup({ token: "" });
    expect(noToken.els["map-toggle"].hidden).toBe(true);
    expect(noToken.rec.mapOptions).toBeNull();
  });

  test("with Mapbox GL the toggle shows, the map is not built until it is opened", () => {
    const t = setup();
    expect(t.els["map-toggle"].hidden).toBe(false);
    expect(t.rec.mapOptions).toBeNull();
    expect(t.els["search-map-panel"].hidden).toBe(true);
  });

  test("opening shows the panel, switches the view, labels the button, builds the map once", () => {
    const t = setup();
    t.openMap();
    expect(t.els["search-map-panel"].hidden).toBe(false);
    expect(t.els["search-split"].dataset.view).toBe("map");
    expect(t.els["map-toggle"].textContent).toBe("Hide map");
    expect(t.els["map-toggle"].attributes["aria-pressed"]).toBe("true");
    expect(t.rec.mapOptions.accessToken).toBe("pk.x");
    t.openMap(); // close
    expect(t.els["search-map-panel"].hidden).toBe(true);
    expect(t.els["search-split"].dataset.view).toBe("list");
    expect(t.els["map-toggle"].textContent).toBe("Show map");
    const first = t.rec.mapOptions;
    t.openMap(); // reopen: the same map, resized
    expect(t.rec.mapOptions).toBe(first);
  });

  test("on load it adds a clustered source and the cluster, count, highlight and price layers", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([feat("a1", 73.8, 15.5), feat("b2", 74.1, 15.7)]));
    await t.load();
    expect(t.rec.sources.stays.cluster).toBe(true);
    expect(t.rec.layers.map((l) => l.id)).toEqual(["stay-clusters", "stay-cluster-count", "stay-highlight", "stay-label"]);
    const clusters = t.rec.layers[0];
    expect(clusters.paint["circle-color"]).toBe("teal"); // read from the CSS token
  });

  test("the first load has no bbox and passes the page's filters; it then fits the results", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([feat("a1", 73.8, 15.5), feat("b2", 74.1, 15.7)]));
    await t.load();
    const url = new URL("http://x" + t.rec.fetches[0].url);
    expect(url.pathname).toBe("/api/search/map");
    expect(url.searchParams.get("dest")).toBe("Goa");
    expect(url.searchParams.get("guests")).toBe("2");
    expect(url.searchParams.has("bbox")).toBe(false);
    expect(t.rec.sources.stays.data.features).toHaveLength(2);
    expect(t.rec.fit[0][0]).toEqual([[73.8, 15.5], [74.1, 15.7]]);
    expect(t.els["map-status"].textContent).toBe("2 stays on the map.");
  });

  test("a single result centres on it instead of fitting a zero-size box", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([feat("a1", 73.8, 15.5)]));
    await t.load();
    expect(t.rec.easeTo[0].center).toEqual([73.8, 15.5]);
    expect(t.els["map-status"].textContent).toBe("1 stay on the map.");
  });

  test("the server's message (cap, no results) is shown as it is", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([], { message: "No stays in this area." }));
    await t.load();
    expect(t.els["map-status"].textContent).toBe("No stays in this area.");
    t.respond(FC([feat("a1", 1, 1)], { message: "Showing 200 of 450 stays. Zoom in to see the rest." }));
    t.els["map-search-area"].listeners.click();
    await t.flush();
    expect(t.els["map-status"].textContent).toBe("Showing 200 of 450 stays. Zoom in to see the rest.");
  });

  test("moving the map offers 'Search this area'; clicking it loads with the map's bbox", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([feat("a1", 73.8, 15.5), feat("b2", 74.1, 15.7)]));
    await t.load(); // fits the results: that move is the script's own
    t.rec.handlers.moveend(); // the fit's own move: ignored
    expect(t.els["map-search-area"].hidden).toBe(true);
    t.rec.handlers.moveend(); // the user's move
    expect(t.els["map-search-area"].hidden).toBe(false);
    t.setBounds([10, 20, 11, 21]);
    t.els["map-search-area"].listeners.click();
    expect(t.els["map-search-area"].hidden).toBe(true);
    const url = new URL("http://x" + t.rec.fetches[t.rec.fetches.length - 1].url);
    expect(url.searchParams.get("bbox")).toBe("10,20,11,21");
    expect(url.searchParams.get("dest")).toBe("Goa");
  });

  test("with 'Search as I move the map' on, a move reloads after a short pause, and the button is not offered", async () => {
    const t = setup();
    t.openMap();
    t.respond(FC([feat("a1", 73.8, 15.5), feat("b2", 74.1, 15.7)]));
    await t.load(); // fit -> programmatic flag set
    t.rec.handlers.moveend(); // consumes the flag
    t.els["map-follow"].checked = true;
    t.els["map-follow"].listeners.change(); // turning it on loads the current view at once
    const before = t.rec.fetches.length;
    t.setBounds([1, 2, 3, 4]);
    t.rec.handlers.moveend();
    expect(t.els["map-search-area"].hidden).toBe(true);
    const debounce = t.rec.timers.find((x) => x.ms === 400);
    expect(debounce).toBeDefined();
    debounce.fn();
    expect(t.rec.fetches.length).toBe(before + 1);
    expect(new URL("http://x" + t.rec.fetches[before].url).searchParams.get("bbox")).toBe("1,2,3,4");
  });

  test("a failed request says so and keeps the map", async () => {
    const t = setup();
    t.openMap();
    t.respond({}, false);
    await t.load();
    expect(t.els["map-status"].textContent).toMatch(/could not be loaded/);
  });

  test("an error before the map loaded hides the map and points to the list", () => {
    const t = setup();
    t.openMap();
    t.rec.handlers.error({ error: new Error("offline") });
    expect(t.els["map-status"].textContent).toMatch(/list shows the same stays/);
    expect(t.els["search-map"].classes.has("map-unavailable")).toBe(true);
  });

  test("the map never loading falls back after the timeout; a loaded map does not", async () => {
    const stuck = setup();
    stuck.openMap();
    stuck.rec.timers.find((x) => x.ms === 10000).fn();
    expect(stuck.els["search-map"].classes.has("map-unavailable")).toBe(true);

    const ok = setup();
    ok.openMap();
    await ok.load();
    ok.rec.timers.find((x) => x.ms === 10000).fn();
    expect(ok.els["search-map"].classes.has("map-unavailable")).toBe(false);
  });

  test("hovering a card lights its price on the map; leaving clears it", async () => {
    const t = setup();
    t.openMap();
    await t.load();
    const target = { closest: () => t.cards.a1 };
    t.els.results.listeners.mouseover({ target });
    expect(t.rec.filters.pop()).toEqual(["stay-highlight", ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "a1"]]]);
    t.els.results.listeners.mouseout();
    expect(t.rec.filters.pop()[1][2]).toEqual(["==", ["get", "id"], ""]);
  });

  test("hovering a price on the map lights its card", async () => {
    const t = setup();
    t.openMap();
    await t.load();
    t.rec.layerHandlers["mouseenter:stay-label"]({ features: [{ properties: { id: "a1" } }] });
    expect(t.cards.a1.classes.has("is-highlighted")).toBe(true);
    const lit = [t.cards.a1];
    t.els.results.querySelectorAll = () => lit;
    t.rec.layerHandlers["mouseleave:stay-label"]();
    expect(t.cards.a1.classes.has("is-highlighted")).toBe(false);
  });

  test("clicking a price opens a popup built from text with a same-site link only", async () => {
    const t = setup();
    t.openMap();
    await t.load();
    const evil = { geometry: { coordinates: [1, 2] }, properties: { id: "x", title: '<img src=x onerror="alert(1)">', priceLabel: "₹1", url: "https://evil.example/" } };
    t.rec.layerHandlers["click:stay-label"]({ features: [evil] });
    const [heading, price, link] = t.rec.popup.children;
    expect(heading.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(price.textContent).toBe("₹1 / night");
    expect(link).toBeUndefined(); // an off-site url is never linked
    const good = { ...evil, properties: { ...evil.properties, url: "/listings/abc" } };
    t.rec.layerHandlers["click:stay-label"]({ features: [good] });
    expect(t.rec.popup.children[2].href).toBe("/listings/abc");
  });

  test("clicking a cluster zooms in to where it splits", async () => {
    const t = setup();
    t.openMap();
    await t.load();
    t.rec.layerHandlers["click:stay-clusters"]({ features: [{ properties: { cluster_id: 7 }, geometry: { coordinates: [5, 6] } }] });
    expect(t.rec.easeTo.pop()).toEqual({ center: [5, 6], zoom: 9, duration: 250 });
  });

  describe("motion and loading (P18-T04)", () => {
    test("a cluster opens in 250 ms, never the 500 ms Mapbox would choose by itself", async () => {
      const t = setup({ reduceMotion: false });
      t.openMap();
      await t.load();
      t.rec.layerHandlers["click:stay-clusters"]({ features: [{ properties: { cluster_id: 7 }, geometry: { coordinates: [5, 6] } }] });
      expect(t.rec.easeTo.pop().duration).toBe(250);
    });

    test("with 'reduce motion' the map jumps (duration 0), and every other move already did", async () => {
      const t = setup({ reduceMotion: true });
      t.openMap();
      t.respond(FC([feat("a1", 74, 15)]));
      await t.load();
      t.rec.layerHandlers["click:stay-clusters"]({ features: [{ properties: { cluster_id: 7 }, geometry: { coordinates: [5, 6] } }] });
      expect(t.rec.easeTo.pop().duration).toBe(0);
      for (const move of [...t.rec.easeTo, ...t.rec.fit.map(([, options]) => options)]) expect(move.duration).toBe(0);
    });

    test("a page without matchMedia is read as no preference", async () => {
      const t = setup();
      t.openMap();
      await t.load();
      t.rec.layerHandlers["click:stay-clusters"]({ features: [{ properties: { cluster_id: 7 }, geometry: { coordinates: [5, 6] } }] });
      expect(t.rec.easeTo.pop().duration).toBe(250);
    });

    test("the map shows its loading look while the stays load and drops it when they arrive", async () => {
      const t = setup();
      t.openMap();
      t.respond(FC([feat("a1", 74, 15)]));
      const loaded = t.load();
      expect(t.els["search-map"].classes.has("is-loading")).toBe(true);
      await loaded;
      expect(t.els["search-map"].classes.has("is-loading")).toBe(false);
    });

    test("it also drops the loading look when the request fails, and when the map cannot start", async () => {
      const failed = setup();
      failed.openMap();
      failed.respond({}, false);
      await failed.load();
      expect(failed.els["search-map"].classes.has("is-loading")).toBe(false);

      const broken = setup();
      broken.openMap();
      broken.els["search-map"].classes.add("is-loading");
      broken.rec.handlers.error({ error: new Error("offline") });
      expect(broken.els["search-map"].classes.has("is-loading")).toBe(false);
      expect(broken.els["search-map"].classes.has("map-unavailable")).toBe(true);
    });
  });
});
