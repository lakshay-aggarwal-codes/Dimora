// "What's around" on the listing page (P15-T02).
// 1. Turns the lists into tabs (arrow keys, Home, End; Tab moves on to the list).
//    Without this file all lists stay visible one under the other.
// 2. If the detail map (public/js/map.js) loads, offers a checkbox that draws ONE
//    dashed circle around the approximate centre: how far the nearest place of the
//    chosen kind is. A circle is a radius, not a position; no place is plotted.
// The server's text is only ever inserted as text, never as HTML.
(function () {
  "use strict";

  var root = document.querySelector("[data-neighborhood]");
  if (!root) return;

  var tablist = root.querySelector("[data-tablist]");
  var tabs = Array.prototype.slice.call(root.querySelectorAll("[role=tab]"));
  var panels = {};
  Array.prototype.forEach.call(root.querySelectorAll("[data-panel]"), function (panel) {
    panels[panel.getAttribute("data-panel")] = panel;
  });
  if (!tablist || tabs.length === 0) return;

  var rings = {};
  try {
    JSON.parse(root.getAttribute("data-rings") || "[]").forEach(function (ring) {
      if (ring && typeof ring.id === "string" && Number.isFinite(ring.radiusM) && ring.radiusM > 0) {
        rings[ring.id] = ring;
      }
    });
  } catch (err) {
    rings = {};
  }

  var current = null;

  function select(tab, focus) {
    current = tab.getAttribute("data-category");
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
    Object.keys(panels).forEach(function (id) {
      panels[id].hidden = id !== current;
    });
    if (focus) tab.focus();
    updateRing();
  }

  // Enhance: tabs visible, panels become tab panels, the first one shows.
  root.classList.add("is-tabbed");
  tablist.hidden = false;
  tabs.forEach(function (tab) {
    var id = tab.getAttribute("data-category");
    var panel = panels[id];
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      panel.setAttribute("tabindex", "0");
    }
    tab.addEventListener("click", function () {
      select(tab, false);
    });
    tab.addEventListener("keydown", function (event) {
      var index = tabs.indexOf(tab);
      var next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        select(next, true);
      }
    });
  });

  // ---- map circle -------------------------------------------------------
  var control = root.querySelector("[data-ring-control]");
  var checkbox = root.querySelector("#nb-ring");
  var note = root.querySelector("[data-ring-note]");
  var EARTH_RADIUS_M = 6371008.8;
  var SOURCE_ID = "nearby-distance";
  var shown = false;

  function circleRing(lng, lat, radiusM) {
    var rad = function (d) { return (d * Math.PI) / 180; };
    var deg = function (r) { return (r * 180) / Math.PI; };
    var lat1 = rad(lat);
    var lng1 = rad(lng);
    var delta = radiusM / EARTH_RADIUS_M;
    var ring = [];
    for (var i = 0; i < 64; i += 1) {
      var bearing = (2 * Math.PI * i) / 64;
      var sinLat2 = Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(bearing);
      var lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
      var lng2 = lng1 + Math.atan2(
        Math.sin(bearing) * Math.sin(delta) * Math.cos(lat1),
        Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2)
      );
      ring.push([deg(lng2), Math.max(-85, Math.min(85, deg(lat2)))]);
    }
    ring.push(ring[0]);
    return ring;
  }

  function clearRing(map) {
    try {
      if (map.getLayer(SOURCE_ID)) map.removeLayer(SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch (err) {
      console.error("Distance circle cleanup failed:", err);
    }
  }

  function updateRing() {
    var detail = window.dimoraDetailMap;
    if (!detail || !detail.map || !checkbox) return;
    var map = detail.map;
    clearRing(map);
    shown = false;
    if (!checkbox.checked || !current || !rings[current]) {
      if (note) note.textContent = "";
      return;
    }
    var ring = rings[current];
    try {
      var coordinates = circleRing(detail.lng, detail.lat, ring.radiusM);
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coordinates } },
      });
      map.addLayer({
        id: SOURCE_ID,
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#7c2d12", "line-width": 2, "line-dasharray": [2, 2] },
      });
      var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      coordinates.forEach(function (p) {
        minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]);
        minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
      });
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 24, maxZoom: 15 });
      shown = true;
      if (note) {
        note.textContent =
          "Dashed circle: the nearest " + ring.label.toLowerCase() +
          " is about " + ring.radiusM + " m from the approximate centre.";
      }
    } catch (err) {
      console.error("Distance circle failed:", err);
      checkbox.checked = false;
      if (note) note.textContent = "The circle could not be drawn.";
    }
  }

  function offerRing() {
    if (!control || !checkbox || !window.dimoraDetailMap) return;
    control.hidden = false;
    checkbox.addEventListener("change", updateRing);
  }

  if (window.dimoraDetailMap) offerRing();
  else window.addEventListener("dimora:map-loaded", offerRing, { once: true });

  select(tabs[0], false);
})();
