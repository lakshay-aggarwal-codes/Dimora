const { ValidationError } = require("../utils/errors");
const {
  geocodeAddress,
  LocationNotFoundError,
  GeocoderUnavailableError,
} = require("../services/geocoding");

// A new listing must come with a photo. (multer has already parsed the form.)
module.exports.requireImage = (req, res, next) => {
  if (!req.file) {
    throw new ValidationError("Please choose an image for your listing.");
  }
  next();
};

function hasGeometry(listing) {
  return Boolean(
    listing.geometry &&
    Array.isArray(listing.geometry.coordinates) &&
    listing.geometry.coordinates.length >= 2,
  );
}

/**
 * Sets req.geometry from the submitted location + country.
 * On edit (req.listing is set by isOwner) it only looks the place up again when
 * the location or country changed, or when the stored listing has no coordinates.
 * A place that cannot be found, or a geocoder outage, flashes a message and sends
 * the user back to the form (`backTo(req)`) so nothing is uploaded or saved.
 */
module.exports.geocodeListing = ({ backTo }) =>
  async function geocodeListing(req, res, next) {
    const { location, country } = req.body.listing;
    const existing = req.listing;
    if (
      existing &&
      existing.location === location &&
      existing.country === country &&
      hasGeometry(existing)
    ) {
      return next();
    }
    try {
      req.geometry = await geocodeAddress({ location, country });
    } catch (err) {
      if (
        err instanceof LocationNotFoundError ||
        err instanceof GeocoderUnavailableError
      ) {
        if (req.log && err instanceof GeocoderUnavailableError) {
          req.log.warn({ err }, "geocoding failed");
        }
        req.flash("error", err.message);
        return res.redirect(backTo(req));
      }
      throw err;
    }
    next();
  };
