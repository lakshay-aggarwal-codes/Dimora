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

// ---------------------------------------------------------------------------
// Approximate public location (P06-T02).
//
// The map a visitor sees must not reveal where a home is. Each listing has a
// public point: the precise point moved 300 to 800 metres in a direction that
// depends on the listing id AND a server secret (HMAC-SHA256). Both matter:
//   * deterministic: the same listing always gets the same public point, so
//     reloading the page and averaging the answers gains nothing;
//   * keyed: the id is public (it is in the URL), so an offset computed from
//     the id alone could be computed by anybody and subtracted again. With the
//     secret, the offset is unknowable from outside.
// The move is a great-circle step, so it is right near the poles and across the
// antimeridian (longitude wraps).
// ---------------------------------------------------------------------------
const crypto = require("node:crypto");

const EARTH_RADIUS_M = 6371008.8;
const MIN_OFFSET_M = 300;
const MAX_OFFSET_M = 800;
const COORDINATE_DECIMALS = 5; // about 1 m
// Rounding to 5 decimals can move a point by up to about 1 m, so the step is
// drawn from [300 + 1, 800 - 1]: the rounded point is still 300 to 800 m away.
const ROUNDING_MARGIN_M = 1;
const DEV_SECRET = "dimora-development-location-secret-not-for-production";

let locationSecret = null;

/**
 * Sets the secret the offsets are keyed with. Called once at start-up with the
 * session secret (src/app.js). Changing it moves every public point (they are
 * recomputed the next time a listing is saved, or by migration 007).
 */
function configureLocationSecret(secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TypeError("The location secret must be a string of at least 16 characters");
  }
  locationSecret = `${secret}|dimora-location-v1`;
}

function secretInUse() {
  if (locationSecret) return locationSecret;
  // Only a development or test run may fall back; a production run that never
  // configured a secret must fail rather than use a key anyone can read here.
  if (process.env.NODE_ENV === "production") {
    throw new Error("The location secret is not configured");
  }
  return `${DEV_SECRET}|dimora-location-v1`;
}

/** The step for a listing: a direction (radians) and a distance (metres). */
function offsetFor(listingId, secret = secretInUse()) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`offset|${String(listingId)}`)
    .digest();
  const unit = (from) => digest.readUIntBE(from, 6) / 2 ** 48; // [0, 1)
  return {
    bearing: unit(0) * 2 * Math.PI,
    meters:
      MIN_OFFSET_M +
      ROUNDING_MARGIN_M +
      unit(6) * (MAX_OFFSET_M - MIN_OFFSET_M - 2 * ROUNDING_MARGIN_M),
  };
}

const round = (value) => Number(value.toFixed(COORDINATE_DECIMALS));

/**
 * The public point for a precise GeoJSON Point.
 * @returns {{ type: "Point", coordinates: [number, number] } | null} null when
 * the precise point is unusable or there is no id.
 */
function approximatePoint(geometry, listingId, { secret } = {}) {
  const precise = toMapPoint(geometry);
  if (!precise || listingId === undefined || listingId === null || String(listingId) === "") {
    return null;
  }
  const { bearing, meters } = offsetFor(listingId, secret);
  const delta = meters / EARTH_RADIUS_M;
  const lat1 = (precise.lat * Math.PI) / 180;
  const lng1 = (precise.lng * Math.PI) / 180;

  const sinLat2 = Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(bearing);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );

  const lat = Math.max(-90, Math.min(90, (lat2 * 180) / Math.PI));
  let lng = (lng2 * 180) / Math.PI;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180; // wrap into [-180, 180)
  return { type: "Point", coordinates: [round(lng), round(lat)] };
}

/** Great-circle distance in metres between two { lng, lat } points. */
function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The { lng, lat } a page may show for a listing (a document or plain object):
 * its stored public point, or, for a listing saved before this existed, the
 * public point computed from its precise one. Never the precise point itself.
 */
function publicPointOf(listing) {
  if (!listing) return null;
  const read = (path) => (typeof listing.get === "function" ? listing.get(path) : path.split(".").reduce((n, k) => (n == null ? undefined : n[k]), listing));
  const stored = toMapPoint({
    type: read("publicGeometry.type"),
    coordinates: read("publicGeometry.coordinates") && Array.from(read("publicGeometry.coordinates")),
  });
  if (stored) return stored;
  const precise = {
    type: read("geometry.type"),
    coordinates: read("geometry.coordinates") && Array.from(read("geometry.coordinates")),
  };
  const id = read("_id");
  return toMapPoint(approximatePoint(precise, id));
}

module.exports = {
  toMapPoint,
  approximatePoint,
  publicPointOf,
  distanceMeters,
  configureLocationSecret,
  offsetFor,
  MIN_OFFSET_M,
  MAX_OFFSET_M,
};
