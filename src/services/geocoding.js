const mbxGeocoding = require("@mapbox/mapbox-sdk/services/geocoding");
const { loadEnv } = require("../config/env");
const { AppError, ValidationError } = require("../utils/errors");

// Built on first use so that requiring this file does not need the environment.
// server.js calls getGeocodingClient() at startup so a malformed
// MAPBOX_SERVER_TOKEN still stops the server at boot.
let client;
function getGeocodingClient() {
  if (!client) {
    client = mbxGeocoding({ accessToken: loadEnv().mapbox.serverToken });
  }
  return client;
}

// The place could not be found: the user can fix it, so it is a 400.
class LocationNotFoundError extends ValidationError {
  constructor() {
    super(
      "We couldn't find that location. Check the spelling or add the city and country.",
      { code: "location_not_found" },
    );
  }
}

// Mapbox failed or timed out: not the user's fault, safe to retry.
class GeocoderUnavailableError extends AppError {
  constructor(cause) {
    super(
      503,
      "Location lookup is temporarily unavailable. Please try again in a moment.",
      { code: "geocoder_unavailable", cause },
    );
  }
}

function isPoint(geometry) {
  return (
    geometry &&
    geometry.type === "Point" &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length >= 2 &&
    geometry.coordinates.slice(0, 2).every((n) => Number.isFinite(n))
  );
}

/**
 * Looks a place up and returns a GeoJSON Point `{ type, coordinates: [lng, lat] }`.
 * Throws LocationNotFoundError (no/invalid result) or GeocoderUnavailableError.
 */
async function geocodeAddress({ location, country }) {
  const query = [location, country]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(", ");
  if (!query) throw new LocationNotFoundError();

  // Outside the try: a missing/invalid token is a configuration bug (500), not
  // a temporary outage.
  const geocoder = getGeocodingClient();
  let response;
  try {
    response = await geocoder.forwardGeocode({ query, limit: 1 }).send();
  } catch (err) {
    throw new GeocoderUnavailableError(err);
  }

  const features = response && response.body && response.body.features;
  const geometry =
    Array.isArray(features) && features[0] && features[0].geometry;
  if (!isPoint(geometry)) throw new LocationNotFoundError();
  return {
    type: "Point",
    coordinates: [geometry.coordinates[0], geometry.coordinates[1]],
  };
}

module.exports = {
  getGeocodingClient,
  geocodeAddress,
  LocationNotFoundError,
  GeocoderUnavailableError,
};
