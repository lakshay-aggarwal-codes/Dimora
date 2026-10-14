// Middleware used by the listing routes, with the model stubbed (no database).
const { validateListing } = require("../../src/middleware");
const {
  requireImage,
  geocodeListing,
} = require("../../src/middleware/listing");
const { ValidationError } = require("../../src/utils/errors");
const { geocoding, resetExternalMocks } = require("../helpers/mocks");
const { loadEnv, resetConfigCache } = require("../../src/config/env");

let saved;
beforeAll(() => {
  saved = { ...process.env };
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
  loadEnv();
});
afterAll(() => {
  process.env = saved;
  resetConfigCache();
});
afterEach(resetExternalMocks);

const form = (listing) => ({
  listing: {
    title: "Cottage",
    description: "Nice",
    location: "Goa",
    country: "India",
    price: "2500",
    ...listing,
  },
});

describe("validateListing", () => {
  test("trims text, converts price and replaces req.body", () => {
    const req = { body: form({ title: "  Cottage  ", price: "2500" }) };
    const next = jest.fn();
    validateListing(req, {}, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.listing.title).toBe("Cottage");
    expect(req.body.listing.price).toBe(2500);
  });

  test("rejects a missing body, blank fields, negative price and a text image field", () => {
    const bad = [
      undefined,
      {},
      form({ title: "   " }),
      form({ price: "-1" }),
      form({ price: "abc" }),
      form({ image: { url: "http://evil.example/x.png" } }),
    ];
    for (const body of bad) {
      expect(() => validateListing({ body }, {}, jest.fn())).toThrow(
        ValidationError,
      );
    }
  });
});

describe("requireImage", () => {
  test("no file is a 400 validation error", () => {
    expect(() => requireImage({}, {}, jest.fn())).toThrow(ValidationError);
    const next = jest.fn();
    requireImage({ file: {} }, {}, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("geocodeListing", () => {
  const mw = geocodeListing({ backTo: (r) => `/back/${r.params.id}` });
  const mk = (listing, existing) => ({
    body: { listing: { location: "Goa", country: "India", ...listing } },
    params: { id: "L1" },
    listing: existing,
    flash: jest.fn(),
  });

  test("creates: geocodes and sets req.geometry", async () => {
    const req = mk();
    const next = jest.fn();
    await mw(req, { redirect: jest.fn() }, next);
    expect(req.geometry.type).toBe("Point");
    expect(next).toHaveBeenCalled();
  });

  test("edit with the same place and stored coordinates does not call Mapbox", async () => {
    const existing = {
      location: "Goa",
      country: "India",
      geometry: { coordinates: [1, 2] },
    };
    const req = mk({}, existing);
    const next = jest.fn();
    await mw(req, { redirect: jest.fn() }, next);
    expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
    expect(req.geometry).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test("edit geocodes again when the location or country changed, or coordinates are missing", async () => {
    const stored = {
      location: "Goa",
      country: "India",
      geometry: { coordinates: [1, 2] },
    };
    for (const [listing, existing] of [
      [{ location: "Pune" }, stored],
      [{ country: "Nepal" }, stored],
      [{}, { ...stored, geometry: { coordinates: [] } }],
      [{}, { ...stored, geometry: undefined }],
    ]) {
      geocoding.forwardGeocode.mockClear();
      const req = mk(listing, existing);
      await mw(req, { redirect: jest.fn() }, jest.fn());
      expect(geocoding.forwardGeocode).toHaveBeenCalledTimes(1);
      expect(req.geometry).toBeDefined();
    }
  });

  test("an unknown place or an outage flashes a message and goes back to the form", async () => {
    for (const arrange of [
      () => geocoding.__noResults(),
      () => geocoding.__failWith(new Error("down")),
    ]) {
      resetExternalMocks();
      arrange();
      const req = mk();
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith("/back/L1");
      expect(req.flash).toHaveBeenCalledWith("error", expect.any(String));
    }
  });
});
