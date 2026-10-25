// Detail-page map (P06-T03). It draws a circle around the listing's PUBLIC
// (approximate) point, never a pin: the exact address is shared after booking.
// Everything it needs comes from data- attributes on #map (set by
// views/listings/show.ejs): data-token, data-lng, data-lat, data-radius (metres),
// data-title. No server data is evaluated as code and text is only ever
// inserted as text, never as HTML.
// If the map cannot be drawn (no library, bad token, offline, no WebGL) the
// text that the server put inside #map stays visible.
(function () {
  const el = document.getElementById("map");
  if (!el) return;

  const EARTH_RADIUS_M = 6371008.8;
  const LOAD_TIMEOUT_MS = 10000;
  const DEFAULT_RADIUS_M = 1000;
  const MIN_RADIUS_M = 100;
  const MAX_RADIUS_M = 5000;
  const STEPS = 64;

  function toNumber(value) {
    if (typeof value !== "string" || value.trim() === "") return NaN;
    return Number(value);
  }

  // The server-rendered description of the area ("Approximate area: Goa, India.")
  const fallbackText = (el.textContent || "").trim();
  let map = null;
  let loaded = false;
  let failed = false;

  function unavailable(message) {
    if (failed) return;
    failed = true;
    if (map && typeof map.remove === "function") {
      try {
        map.remove();
      } catch (err) {
        console.error("Map cleanup failed:", err);
      }
    }
    el.textContent = fallbackText ? message + " " + fallbackText : message;
    el.classList.add("map-unavailable");
  }

  // Points of a circle of `radiusM` metres around (lng, lat), by great-circle
  // steps. Longitudes are left unwrapped so a circle across the antimeridian
  // stays one continuous ring; latitudes are kept inside the Mercator limit.
  function circleRing(lng, lat, radiusM) {
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const lat1 = rad(lat);
    const lng1 = rad(lng);
    const delta = radiusM / EARTH_RADIUS_M;
    const ring = [];
    for (let i = 0; i < STEPS; i += 1) {
      const bearing = (2 * Math.PI * i) / STEPS;
      const sinLat2 =
        Math.sin(lat1) * Math.cos(delta) +
        Math.cos(lat1) * Math.sin(delta) * Math.cos(bearing);
      const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
      const lng2 =
        lng1 +
        Math.atan2(
          Math.sin(bearing) * Math.sin(delta) * Math.cos(lat1),
          Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
        );
      ring.push([deg(lng2), Math.max(-85, Math.min(85, deg(lat2)))]);
    }
    ring.push(ring[0]);
    return ring;
  }

  function boundsOf(ring) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    ring.forEach(function (point) {
      minLng = Math.min(minLng, point[0]);
      maxLng = Math.max(maxLng, point[0]);
      minLat = Math.min(minLat, point[1]);
      maxLat = Math.max(maxLat, point[1]);
    });
    return [
      [minLng, minLat],
      [maxLng, maxLat],
    ];
  }

  const lng = toNumber(el.dataset.lng);
  const lat = toNumber(el.dataset.lat);
  const token = el.dataset.token;
  const title = el.dataset.title || "";
  const rawRadius = el.dataset.radius === undefined ? DEFAULT_RADIUS_M : toNumber(el.dataset.radius);
  const radius =
    Number.isFinite(rawRadius) && rawRadius >= MIN_RADIUS_M && rawRadius <= MAX_RADIUS_M
      ? rawRadius
      : DEFAULT_RADIUS_M;

  const validPoint =
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90;
  if (!validPoint) {
    unavailable("The map is not available for this listing.");
    return;
  }
  if (typeof mapboxgl === "undefined" || !token) {
    unavailable("The map could not be loaded.");
    return;
  }

  try {
    const ring = circleRing(lng, lat, radius);

    // The old text is replaced once the map exists; it comes back on failure.
    el.textContent = "";
    if (title && typeof el.setAttribute === "function") {
      el.setAttribute("aria-label", "Approximate area map for " + title);
    }

    map = new mapboxgl.Map({
      accessToken: token,
      container: el,
      center: [lng, lat], // [lng, lat]; lat must be between -90 and 90
      bounds: boundsOf(ring),
      fitBoundsOptions: { padding: 24, maxZoom: 15 },
    });

    if (typeof map.addControl === "function" && typeof mapboxgl.NavigationControl === "function") {
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    }

    map.on("load", function () {
      loaded = true;
      map.addSource("approximate-area", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
      });
      map.addLayer({
        id: "approximate-area-fill",
        type: "fill",
        source: "approximate-area",
        paint: { "fill-color": "#0f766e", "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: "approximate-area-outline",
        type: "line",
        source: "approximate-area",
        paint: { "line-color": "#0f766e", "line-width": 2 },
      });
      // Lets public/js/neighborhood.js add its distance circles (P15-T02).
      window.dimoraDetailMap = { map: map, lng: lng, lat: lat };
      window.dispatchEvent(new CustomEvent("dimora:map-loaded"));
    });

    // An error before the first load (invalid token, offline, blocked style)
    // means there is nothing to show; later tile errors are ignored.
    map.on("error", function (event) {
      if (loaded) return;
      console.error("Map failed to load:", event && event.error);
      unavailable("The map could not be loaded.");
    });

    setTimeout(function () {
      if (!loaded) unavailable("The map could not be loaded.");
    }, LOAD_TIMEOUT_MS);
  } catch (err) {
    console.error("Map failed to load:", err);
    unavailable("The map could not be loaded.");
  }
})();
