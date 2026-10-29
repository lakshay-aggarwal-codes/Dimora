// Search within a distance of a destination (P06-T05).
//
// "Goa within 25 km" means: stays within 25 km of the middle of the stays that
// match "Goa" (the same text match as the destination box), so nearby towns with
// another city name are included. The middle is the average of the matching
// stays' PUBLIC points, taken from our own data: no outside geocoding call per
// search (that would cost money for every visitor and Mapbox's temporary mode
// does not allow keeping its results).
//
// Privacy: only `publicGeometry` (the approximate point of P06-T02, 300 to 800 m
// from the real one) is ever read, so which side of the circle a stay falls on
// can be wrong by that much; the circle is therefore never smaller than 5 km.
// The precise `geometry` is not touched.
const { buildFilter } = require("./search");

const RADII_KM = Object.freeze([5, 10, 25, 50]);
const EARTH_RADIUS_KM = 6378.1; // $centerSphere takes radians

/**
 * The middle of the public stays that match a destination text.
 * @param {object} Listing the model
 * @param {string} destination the validated destination text
 * @returns {Promise<{ lng: number, lat: number, count: number } | null>}
 */
async function areaCentre(Listing, destination) {
  const match = { ...buildFilter({ destination }), "publicGeometry.type": "Point" };
  const rows = await Listing.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        lng: { $avg: { $arrayElemAt: ["$publicGeometry.coordinates", 0] } },
        lat: { $avg: { $arrayElemAt: ["$publicGeometry.coordinates", 1] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !Number.isFinite(row.lng) || !Number.isFinite(row.lat)) return null;
  return { lng: row.lng, lat: row.lat, count: row.count };
}

/** The Mongo condition: public point inside the circle (centre as [lng, lat]). */
function areaCondition(centre, km) {
  return {
    publicGeometry: {
      $geoWithin: { $centerSphere: [[centre.lng, centre.lat], km / EARTH_RADIUS_KM] },
    },
  };
}

module.exports = { areaCentre, areaCondition, RADII_KM, EARTH_RADIUS_KM };
