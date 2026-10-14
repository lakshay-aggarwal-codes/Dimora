// Stand-in for `@mapbox/mapbox-sdk/services/geocoding` (mapped in jest.config.js).
// Default: every query resolves to one Point feature (New Delhi).
// Control it with geocoding.__setFeatures([...]) / __noResults() / __reset().
const DEFAULT_FEATURES = [
  { geometry: { type: "Point", coordinates: [77.209, 28.6139] } },
];
let features = DEFAULT_FEATURES;

const forwardGeocode = jest.fn(() => ({
  send: async () => ({ body: { features } }),
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
geocoding.__reset = () => {
  features = DEFAULT_FEATURES;
};

module.exports = geocoding;
