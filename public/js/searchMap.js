// Search map and list/map toggle on /listings (P06-T04).
//
// Progressive enhancement: the page works as a list without this script. The
// "Show map" button stays hidden unless Mapbox GL and a public token are there.
//
// Data comes from GET /api/search/map (GeoJSON of the stays' APPROXIMATE points,
// at most 200). The URL filters are passed on through data-query; the box of the
// map is added as bbox=west,south,east,north. Everything that comes from the
// server (titles, prices, links) is only ever inserted as text or as a checked
// same-site link, never as HTML.
(function () {
  const el = document.getElementById("search-map");
  const toggle = document.getElementById("map-toggle");
  const panel = document.getElementById("search-map-panel");
  const split = document.getElementById("search-split");
  const results = document.getElementById("results");
  if (!el || !toggle || !panel || !split) return;
  if (typeof mapboxgl === "undefined" || !el.dataset.token) return; // list only

  const statusEl = document.getElementById("map-status");
  const follow = document.getElementById("map-follow");
  const searchArea = document.getElementById("map-search-area");

  const SOURCE = "stays";
  const DEFAULT_CENTER = [78.9629, 20.5937]; // India (ADR-008), until the results say otherwise
  const DEFAULT_ZOOM = 3.5;
  const SINGLE_STAY_ZOOM = 13;
  const MOVE_DEBOUNCE_MS = 400;
  const LOAD_TIMEOUT_MS = 10000;
  const FONT = ["DIN Pro Medium", "Arial Unicode MS Bold"];

  let map = null;
  let loaded = false;
  let failed = false;
  let programmatic = false; // true while the script itself moves the map
  let request = null;
  let timer = null;
  let popup = null;

  // "Reduce motion" is honoured here too: Mapbox animates by itself (its default
  // for easeTo is 500 ms), so every move it makes states its duration (P18-T04).
  const reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MOVE_MS = reducedMotion ? 0 : 250; // essential feedback never takes longer than 300 ms

  function say(message) {
    if (statusEl) statusEl.textContent = message;
  }

  // Colours come from the CSS tokens, so the map follows the site's palette.
  function token(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name);
      return value && value.trim() ? value.trim() : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function bboxOfMap() {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  }

  function fail(message) {
    if (failed) return;
    failed = true;
    el.classList.remove("is-loading");
    say(message);
    el.classList.add("map-unavailable");
  }

  function highlight(id) {
    if (!loaded || failed) return;
    map.setFilter("stay-highlight", [
      "all",
      ["!", ["has", "point_count"]],
      ["==", ["get", "id"], id || ""],
    ]);
  }

  function cardFor(id) {
    return results ? results.querySelector('[data-listing-id="' + id + '"]') : null;
  }

  function fitTo(features) {
    if (!features.length) return;
    programmatic = true;
    if (features.length === 1) {
      map.easeTo({ center: features[0].geometry.coordinates, zoom: SINGLE_STAY_ZOOM, duration: 0 });
      return;
    }
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    features.forEach(function (feature) {
      const c = feature.geometry.coordinates;
      minLng = Math.min(minLng, c[0]);
      maxLng = Math.max(maxLng, c[0]);
      minLat = Math.min(minLat, c[1]);
      maxLat = Math.max(maxLat, c[1]);
    });
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 48, maxZoom: 14, duration: 0 },
    );
  }

  // Loads the stays (for `bbox`, or everywhere when null) into the map.
  function load(bbox, options) {
    const fit = Boolean(options && options.fit);
    if (request && typeof request.abort === "function") request.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    request = controller;

    const params = new URLSearchParams(el.dataset.query || "");
    if (bbox) params.set("bbox", bbox.join(","));
    say("Loading stays on the map\u2026");
    el.classList.add("is-loading");

    return fetch((el.dataset.endpoint || "/api/search/map") + "?" + params.toString(), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        el.classList.remove("is-loading");
        map.getSource(SOURCE).setData(data);
        const meta = data.meta || {};
        say(meta.message || String(meta.returned || 0) + (meta.returned === 1 ? " stay" : " stays") + " on the map.");
        if (fit) fitTo(data.features || []);
        return data;
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return null;
        el.classList.remove("is-loading");
        console.error("Map results failed to load:", err);
        say("The stays could not be loaded for the map.");
        return null;
      });
  }

  function showPopup(feature) {
    const p = feature.properties || {};
    const node = document.createElement("div");
    const heading = document.createElement("h3");
    heading.className = "search-map-popup-title";
    heading.textContent = p.title || "Stay";
    node.append(heading);
    if (p.priceLabel) {
      const price = document.createElement("p");
      price.textContent = p.priceLabel + " / night";
      node.append(price);
    }
    if (typeof p.url === "string" && p.url.indexOf("/listings/") === 0) {
      const link = document.createElement("a");
      link.href = p.url;
      link.textContent = "View stay";
      node.append(link);
    }
    if (popup && typeof popup.remove === "function") popup.remove();
    popup = new mapboxgl.Popup({ offset: 14 })
      .setLngLat(feature.geometry.coordinates.slice())
      .setDOMContent(node)
      .addTo(map);
  }

  function addLayers() {
    const primary = token("--color-primary", "#0f766e");
    const text = token("--color-text", "#1f2933");
    const surface = token("--color-surface-raised", "#ffffff");

    map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 13,
    });
    map.addLayer({
      id: "stay-clusters",
      type: "circle",
      source: SOURCE,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": primary,
        "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26],
        "circle-stroke-width": 2,
        "circle-stroke-color": surface,
      },
    });
    map.addLayer({
      id: "stay-cluster-count",
      type: "symbol",
      source: SOURCE,
      filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 13 },
      paint: { "text-color": surface },
    });
    map.addLayer({
      id: "stay-highlight",
      type: "circle",
      source: SOURCE,
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], ""]],
      paint: { "circle-color": primary, "circle-opacity": 0.25, "circle-radius": 24 },
    });
    map.addLayer({
      id: "stay-label",
      type: "symbol",
      source: SOURCE,
      filter: ["!", ["has", "point_count"]],
      layout: {
        "text-field": ["case", ["==", ["get", "priceLabel"], ""], "Stay", ["get", "priceLabel"]],
        "text-font": FONT,
        "text-size": 13,
        "text-allow-overlap": true,
      },
      paint: { "text-color": text, "text-halo-color": surface, "text-halo-width": 3 },
    });

    map.on("click", "stay-clusters", function (event) {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const source = map.getSource(SOURCE);
      source.getClusterExpansionZoom(feature.properties.cluster_id, function (err, zoom) {
        if (err) return;
        map.easeTo({ center: feature.geometry.coordinates, zoom: zoom, duration: MOVE_MS });
      });
    });
    map.on("click", "stay-label", function (event) {
      if (event.features && event.features[0]) showPopup(event.features[0]);
    });

    map.on("mouseenter", "stay-label", function (event) {
      map.getCanvas().style.cursor = "pointer";
      const feature = event.features && event.features[0];
      const card = feature && cardFor(feature.properties.id);
      if (card) card.classList.add("is-highlighted");
    });
    map.on("mouseleave", "stay-label", function () {
      map.getCanvas().style.cursor = "";
      if (!results) return;
      results.querySelectorAll(".is-highlighted").forEach(function (card) {
        card.classList.remove("is-highlighted");
      });
    });
    map.on("mouseenter", "stay-clusters", function () {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "stay-clusters", function () {
      map.getCanvas().style.cursor = "";
    });
  }

  function onMoved() {
    if (programmatic) {
      programmatic = false;
      return;
    }
    if (follow && follow.checked) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        load(bboxOfMap());
      }, MOVE_DEBOUNCE_MS);
    } else if (searchArea) {
      searchArea.hidden = false;
    }
  }

  function start() {
    if (map || failed) return;
    try {
      map = new mapboxgl.Map({
        accessToken: el.dataset.token,
        container: el,
        style: "mapbox://styles/mapbox/streets-v12",
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
      });
      if (typeof map.addControl === "function" && typeof mapboxgl.NavigationControl === "function") {
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
      }
      map.on("load", function () {
        loaded = true;
        addLayers();
        load(null, { fit: true });
      });
      map.on("moveend", onMoved);
      map.on("error", function (event) {
        if (loaded) return;
        console.error("Search map failed to load:", event && event.error);
        fail("The map could not be loaded. The list shows the same stays.");
      });
      setTimeout(function () {
        if (!loaded) fail("The map could not be loaded. The list shows the same stays.");
      }, LOAD_TIMEOUT_MS);
    } catch (err) {
      console.error("Search map failed to load:", err);
      fail("The map could not be loaded. The list shows the same stays.");
    }
  }

  function setView(view) {
    const showMap = view === "map";
    split.dataset.view = showMap ? "map" : "list";
    panel.hidden = !showMap;
    toggle.textContent = showMap ? "Hide map" : "Show map";
    toggle.setAttribute("aria-pressed", showMap ? "true" : "false");
    if (showMap) {
      start();
      if (map && loaded && typeof map.resize === "function") map.resize();
    }
  }

  toggle.hidden = false;
  toggle.addEventListener("click", function () {
    setView(split.dataset.view === "map" ? "list" : "map");
  });

  if (searchArea) {
    searchArea.addEventListener("click", function () {
      searchArea.hidden = true;
      if (loaded) load(bboxOfMap());
    });
  }
  if (follow) {
    follow.addEventListener("change", function () {
      if (!follow.checked) return;
      if (searchArea) searchArea.hidden = true;
      if (loaded) load(bboxOfMap());
    });
  }

  // A card and its price label on the map light up together.
  if (results) {
    results.addEventListener("mouseover", function (event) {
      const card = event.target && event.target.closest ? event.target.closest("[data-listing-id]") : null;
      if (card) highlight(card.dataset.listingId);
    });
    results.addEventListener("mouseout", function () {
      highlight("");
    });
    results.addEventListener("focusin", function (event) {
      const card = event.target && event.target.closest ? event.target.closest("[data-listing-id]") : null;
      if (card) highlight(card.dataset.listingId);
    });
    results.addEventListener("focusout", function () {
      highlight("");
    });
  }
})();
