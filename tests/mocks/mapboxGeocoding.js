// Stand-in for `@mapbox/mapbox-sdk/services/geocoding` (mapped in jest.config.js).
// Default: every query resolves to one Point feature (New Delhi).
// Control it with geocoding.__setFeatures([...]) / __noResults() / __failWith(err) / __reset().
const DEFAULT_FEATURES = [
  { geometry: { type: "Point", coordinates: [77.209, 28.6139] } },
];
let features = DEFAULT_FEATURES;
let failure = null;

const forwardGeocode = jest.fn(() => ({
  send: async () => {
    if (failure) throw failure;
    return { body: { features } };
  },
}));

function geocoding() {
  return { forwardGeocode };
}

geocoding.forwardGeocode = forwardGeocode;
geocoding.__setFeatures = (next) => {
  features = next;
};
geocoding.__noResults = () => {
  features = [];
};
// Make every lookup reject, e.g. __failWith(new Error("Mapbox is down")).
geocoding.__failWith = (err) => {
  failure = err;
};
geocoding.__reset = () => {
  features = DEFAULT_FEATURES;
  failure = null;
};

module.exports = geocoding;
