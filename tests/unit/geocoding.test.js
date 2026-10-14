const assert = require("node:assert/strict");
const { geocoding, resetExternalMocks } = require("../helpers/mocks");
const {
  geocodeAddress,
  LocationNotFoundError,
  GeocoderUnavailableError,
} = require("../../src/services/geocoding");
const { loadEnv, resetConfigCache } = require("../../src/config/env");

const ENV = {
  MONGODB_URI: "mongodb://127.0.0.1:1/x",
  SESSION_SECRET: "dev-secret-not-for-production",
  CLOUDINARY_CLOUD_NAME: "c",
  CLOUDINARY_API_KEY: "k",
  CLOUDINARY_API_SECRET: "s",
  MAPBOX_SERVER_TOKEN: "pk.not-a-real-token",
  MAPBOX_PUBLIC_TOKEN: "pk.public",
};

let saved;
beforeAll(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  resetConfigCache();
  loadEnv();
});
afterAll(() => {
  process.env = saved;
  resetConfigCache();
});
afterEach(resetExternalMocks);

test("looks up 'location, country' and returns a GeoJSON Point", async () => {
  const point = await geocodeAddress({ location: " Goa ", country: "India" });
  expect(point).toEqual({ type: "Point", coordinates: [77.209, 28.6139] });
  expect(geocoding.forwardGeocode).toHaveBeenCalledWith({
    query: "Goa, India",
    limit: 1,
  });
});

test("uses the permanent geocoding mode only when MAPBOX_GEOCODING_PERMANENT=true", async () => {
  process.env.MAPBOX_GEOCODING_PERMANENT = "true";
  resetConfigCache();
  try {
    await geocodeAddress({ location: "Goa", country: "India" });
    expect(geocoding.forwardGeocode).toHaveBeenLastCalledWith({
      query: "Goa, India",
      limit: 1,
      mode: "mapbox.places-permanent",
    });
  } finally {
    delete process.env.MAPBOX_GEOCODING_PERMANENT;
    resetConfigCache();
  }
});

test("no features, a non-Point geometry or bad coordinates are 'location not found'", async () => {
  geocoding.__noResults();
  await assert.rejects(
    () => geocodeAddress({ location: "Nowhere", country: "X" }),
    LocationNotFoundError,
  );
  geocoding.__setFeatures([{ geometry: { type: "Polygon", coordinates: [] } }]);
  await assert.rejects(
    () => geocodeAddress({ location: "A", country: "B" }),
    LocationNotFoundError,
  );
  geocoding.__setFeatures([
    { geometry: { type: "Point", coordinates: ["x", 1] } },
  ]);
  await assert.rejects(
    () => geocodeAddress({ location: "A", country: "B" }),
    LocationNotFoundError,
  );
  geocoding.__setFeatures([{}]);
  await assert.rejects(
    () => geocodeAddress({ location: "A", country: "B" }),
    LocationNotFoundError,
  );
});

test("an empty query never calls Mapbox", async () => {
  await assert.rejects(
    () => geocodeAddress({ location: "  ", country: "" }),
    LocationNotFoundError,
  );
  expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
});

test("a Mapbox failure is 'unavailable' (503) and keeps the cause", async () => {
  const boom = new Error("socket hang up");
  geocoding.__failWith(boom);
  const err = await geocodeAddress({ location: "A", country: "B" }).catch(
    (e) => e,
  );
  expect(err).toBeInstanceOf(GeocoderUnavailableError);
  expect(err.statusCode).toBe(503);
  expect(err.code).toBe("geocoder_unavailable");
  expect(err.cause).toBe(boom);
  expect(err.message).not.toMatch(/socket hang up/);
});

test("not-found is a 400 the user can fix", () => {
  const err = new LocationNotFoundError();
  expect(err.statusCode).toBe(400);
  expect(err.code).toBe("location_not_found");
});
