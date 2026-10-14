// Access to the Cloudinary / Mapbox mocks and a reset for both.
const cloudinary = require("cloudinary");
const geocoding = require("@mapbox/mapbox-sdk/services/geocoding");

function resetExternalMocks() {
  geocoding.__reset();
  cloudinary.__resetCounter();
}

module.exports = {
  cloudinary,
  uploader: cloudinary.v2.uploader,
  geocoding,
  resetExternalMocks,
};
