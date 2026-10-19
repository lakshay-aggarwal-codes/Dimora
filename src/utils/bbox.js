// The map box of a search (P06-T04): ?bbox=west,south,east,north in degrees,
// the order Mapbox GL's map.getBounds().toArray() gives them.
//
// Only four plain numbers are accepted; anything else is refused with a
// message, so nothing but numbers ever reaches a database query.
//
// The box is turned into one or two longitude/latitude boxes:
//   * a box 360 degrees wide or wider (zoomed right out, Mapbox can report
//     -250 .. 250) covers every longitude;
//   * a box that crosses the antimeridian (170 .. -170, or 170 .. 190) is two
//     boxes, 170 .. 180 and -180 .. -170.
const MAX_LNG_ABS = 720; // far more than any real map reports
const WORLD_WIDTH = 360;

// Longitudes already inside [-180, 180] are returned untouched (the arithmetic
// below would add rounding noise to them); only outside values are wrapped.
function wrapLng(lng) {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * @param {unknown} value the raw query value
 * @returns {{ ok: true, boxes: Array<{west:number,south:number,east:number,north:number}> }
 *   | { ok: false, message: string }}
 */
function parseBbox(value) {
  if (typeof value !== "string") {
    return { ok: false, message: "bbox must be four numbers: west,south,east,north." };
  }
  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((part) => part.trim() === "")) {
    return { ok: false, message: "bbox must be four numbers: west,south,east,north." };
  }
  const [west, south, east, north] = parts.map((part) => Number(part));
  if (![west, south, east, north].every(Number.isFinite)) {
    return { ok: false, message: "bbox must be four numbers: west,south,east,north." };
  }
  if (south < -90 || north > 90 || south > north) {
    return { ok: false, message: "bbox latitudes must be between -90 and 90, south first." };
  }
  if (Math.abs(west) > MAX_LNG_ABS || Math.abs(east) > MAX_LNG_ABS) {
    return { ok: false, message: "bbox longitudes are out of range." };
  }

  let width = east - west;
  if (width < 0) width += WORLD_WIDTH; // wrapped input: 170,..,-170 crosses the antimeridian
  if (width >= WORLD_WIDTH) {
    return { ok: true, boxes: [{ west: -180, south, east: 180, north }] };
  }

  const w = wrapLng(west);
  const e = wrapLng(east);
  if (w <= e) return { ok: true, boxes: [{ west: w, south, east: e, north }] };
  return {
    ok: true,
    boxes: [
      { west: w, south, east: 180, north },
      { west: -180, south, east: e, north },
    ],
  };
}

module.exports = { parseBbox, wrapLng };
