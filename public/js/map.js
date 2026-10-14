// Detail-page map. Everything it needs comes from data- attributes on #map
// (set by views/listings/show.ejs): data-token, data-lng, data-lat, data-title.
// No server data is evaluated as code, and the title is only ever inserted as
// text, never as HTML.
(function () {
  const el = document.getElementById("map");
  if (!el) return;

  function toNumber(value) {
    if (typeof value !== "string" || value.trim() === "") return NaN;
    return Number(value);
  }

  function unavailable(message) {
    el.textContent = message;
    el.classList.add("map-unavailable");
  }

  const lng = toNumber(el.dataset.lng);
  const lat = toNumber(el.dataset.lat);
  const token = el.dataset.token;
  const title = el.dataset.title || "";

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
    const map = new mapboxgl.Map({
      accessToken: token,
      container: el,
      center: [lng, lat], // [lng, lat]; lat must be between -90 and 90
      zoom: 9,
    });

    const popupContent = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = title;
    const note = document.createElement("p");
    note.textContent = "Exact location after booking";
    popupContent.append(heading, note);

    new mapboxgl.Marker({ color: "red" })
      .setLngLat([lng, lat])
      .setPopup(new mapboxgl.Popup({ offset: 25 }).setDOMContent(popupContent))
      .addTo(map);
  } catch (err) {
    console.error("Map failed to load:", err);
    unavailable("The map could not be loaded.");
  }
})();
