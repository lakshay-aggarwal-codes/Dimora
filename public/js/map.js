const map = new mapboxgl.Map({
  accessToken: mapToken,
  container: "map", // container ID
  center: listing.geomtry.coordinates, // starting position [lng, lat]. Note that lat must be set between -90 and 90
  zoom: 9, // starting zoom
});

const marker = new mapboxgl.Marker({ color: "red" })
  .setLngLat(listing.geomtry.coordinates)
  .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<h4>${listing.title}</h4> <p>Exact Location after booking</p>`))
  .addTo(map);
