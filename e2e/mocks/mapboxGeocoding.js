// Stand-in for `@mapbox/mapbox-sdk/services/geocoding` in the e2e server:
// every address resolves to one point near Panaji, Goa.
const features = [{ geometry: { type: "Point", coordinates: [73.8278, 15.4909] } }];

function geocoding() {
  return {
    forwardGeocode: () => ({ send: async () => ({ body: { features } }) }),
  };
}

module.exports = geocoding;
