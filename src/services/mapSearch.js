// Map data for the search page (P06-T04): the stays that match a search and lie
// inside the map's box, as GeoJSON points.
//
// Privacy: the point of a feature is ALWAYS `publicGeometry` (the approximate
// point of P06-T02). The precise `geometry`, the address and the host never
// enter this module's query projection.
//
// The box is checked with plain longitude/latitude ranges on the coordinates
// (the box on the sphere would curve at its top and bottom edges); with a few
// thousand listings this is fine, a spatial index for it is a later,
// P18-T02, decision.
const { formatMoney } = require("../utils/money");

const MAP_RESULT_CAP = 200;
const PROJECTION = { title: 1, "pricing.nightlyMinor": 1, "pricing.currency": 1, publicGeometry: 1 };

/** Mongo condition for the boxes of parseBbox (one or two, OR-ed). */
function bboxCondition(boxes) {
  const inside = (box) => ({
    "publicGeometry.coordinates.0": { $gte: box.west, $lte: box.east },
    "publicGeometry.coordinates.1": { $gte: box.south, $lte: box.north },
  });
  return boxes.length === 1 ? inside(boxes[0]) : { $or: boxes.map(inside) };
}

/** One GeoJSON feature, or null when the listing has no usable public point. */
function toFeature(listing) {
  const geometry = listing && listing.publicGeometry;
  const coords = geometry && Array.from(geometry.coordinates || []);
  if (
    !geometry ||
    geometry.type !== "Point" ||
    !coords ||
    coords.length < 2 ||
    !Number.isFinite(coords[0]) ||
    !Number.isFinite(coords[1])
  ) {
    return null;
  }
  const minor = listing.pricing && listing.pricing.nightlyMinor;
  const currency = (listing.pricing && listing.pricing.currency) || "INR";
  const hasPrice = Number.isSafeInteger(minor);
  const id = String(listing._id);
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [coords[0], coords[1]] },
    properties: {
      id,
      title: typeof listing.title === "string" ? listing.title : "",
      priceMinor: hasPrice ? minor : null,
      priceLabel: hasPrice ? formatMoney(minor, currency) : "",
      url: `/listings/${id}`,
    },
  };
}

/**
 * @param {object} Listing the model
 * @param {object} filter the search filter (see listingFilterFor)
 * @param {Array|null} boxes parseBbox(...).boxes, or null for "anywhere"
 * @returns {Promise<{ type: "FeatureCollection", features: object[],
 *   meta: { total: number, returned: number, capped: boolean, cap: number, message: string } }>}
 */
async function searchMap(Listing, filter, boxes) {
  const query = { ...filter, "publicGeometry.type": "Point" };
  if (boxes && boxes.length) query.$and = [...(filter.$and || []), bboxCondition(boxes)];

  const total = await Listing.countDocuments(query);
  const docs = total
    ? await Listing.find(query, PROJECTION).sort({ _id: -1 }).limit(MAP_RESULT_CAP).lean()
    : [];
  const features = docs.map(toFeature).filter(Boolean);
  const capped = total > MAP_RESULT_CAP;

  let message = "";
  if (total === 0) message = "No stays in this area.";
  else if (capped) message = `Showing ${features.length} of ${total} stays. Zoom in to see the rest.`;

  return {
    type: "FeatureCollection",
    features,
    meta: { total, returned: features.length, capped, cap: MAP_RESULT_CAP, message },
  };
}

module.exports = { searchMap, bboxCondition, toFeature, MAP_RESULT_CAP };
