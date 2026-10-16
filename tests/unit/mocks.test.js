// The Cloudinary and Mapbox stand-ins (jest.config.js moduleNameMapper) are in
// place, so no test can call the real services.
const assert = require("node:assert/strict");
const { uploader, geocoding, resetExternalMocks } = require("../helpers/mocks");
const { loadEnv, resetConfigCache } = require("../../src/config/env");
const { uploadToCloudinary } = require("../../src/config/cloudinary");

afterEach(resetExternalMocks);

test("the cloudinary package is the mock", () => {
  expect(jest.isMockFunction(uploader.upload_stream)).toBe(true);
  expect(jest.isMockFunction(uploader.destroy)).toBe(true);
});

test("uploadToCloudinary stores the mocked url/public id on req.file and drops the buffer", async () => {
  const req = { file: { buffer: Buffer.from("img"), mimetype: "image/png" } };
  await new Promise((resolve, reject) =>
    uploadToCloudinary(req, {}, (err) => (err ? reject(err) : resolve())),
  );
  assert.match(
    req.file.path,
    /^https:\/\/res\.cloudinary\.test\/dimora_DEV\/image\d+\.jpg$/,
  );
  assert.match(req.file.filename, /^dimora_DEV\/image\d+$/);
  assert.equal(req.file.buffer, undefined);
  expect(uploader.upload_stream).toHaveBeenCalledTimes(1);
  // Cloudinary itself also refuses anything but these formats (D-16)
  expect(uploader.upload_stream.mock.calls[0][0]).toEqual({
    folder: "dimora_DEV",
    resource_type: "image",
    allowed_formats: ["jpg", "png", "webp"],
  });
});

test("a failed upload is passed to next(err) and can be simulated per test", async () => {
  uploader.upload_stream.mockImplementationOnce((options, cb) => ({
    end: () => cb(new Error("cloudinary down")),
  }));
  const req = { file: { buffer: Buffer.from("img") } };
  const err = await new Promise((resolve) =>
    uploadToCloudinary(req, {}, (e) => resolve(e)),
  );
  assert.equal(err.message, "cloudinary down");
});

test("a request without a file skips the upload", async () => {
  const req = {};
  await new Promise((resolve) => uploadToCloudinary(req, {}, resolve));
  expect(uploader.upload_stream).not.toHaveBeenCalled();
});

test("the geocoding mock returns a Point by default and can be steered", async () => {
  const client = geocoding({ accessToken: "ignored" });
  const first = await client.forwardGeocode({ query: "Goa", limit: 1 }).send();
  assert.equal(first.body.features[0].geometry.type, "Point");
  expect(client.forwardGeocode).toHaveBeenCalledWith({
    query: "Goa",
    limit: 1,
  });

  geocoding.__noResults();
  const none = await client.forwardGeocode({ query: "Nowhere" }).send();
  assert.equal(none.body.features.length, 0);

  geocoding.__setFeatures([
    { geometry: { type: "Point", coordinates: [1, 2] } },
  ]);
  const custom = await client.forwardGeocode({ query: "X" }).send();
  assert.deepEqual([...custom.body.features[0].geometry.coordinates], [1, 2]);

  geocoding.__reset();
  const again = await client.forwardGeocode({ query: "Goa" }).send();
  assert.equal(again.body.features.length, 1);
});

test("the listing controller builds its geocoder from the mocked SDK", () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    MONGODB_URI: "mongodb://127.0.0.1:1/x",
    SESSION_SECRET: "dev-secret-not-for-production",
    CLOUDINARY_CLOUD_NAME: "c",
    CLOUDINARY_API_KEY: "k",
    CLOUDINARY_API_SECRET: "s",
    MAPBOX_SERVER_TOKEN: "pk.not-a-real-token",
    MAPBOX_PUBLIC_TOKEN: "pk.public",
  });
  resetConfigCache();
  try {
    loadEnv();
    const { initGeocoding } = require("../../src/controllers/listing");
    const client = initGeocoding();
    expect(jest.isMockFunction(client.forwardGeocode)).toBe(true);
  } finally {
    process.env = saved;
    resetConfigCache();
  }
});
