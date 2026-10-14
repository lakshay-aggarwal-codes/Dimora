// Turns a stored GeoJSON Point into the { lng, lat } pair the detail page puts
// in data- attributes. Returns null when the listing has no usable location
// (old data, or a value outside the valid range), so the page can say so
// instead of drawing a map at a wrong place.
function toMapPoint(geometry) {
  if (!geometry || geometry.type !== "Point") return null;
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const lng = coordinates[0];
  const lat = coordinates[1];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;

  return { lng, lat };
}

module.exports = { toMapPoint };
