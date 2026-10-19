const { toMapPoint } = require("../../src/utils/geo");

describe("toMapPoint", () => {
  test("returns { lng, lat } for a valid GeoJSON Point", () => {
    expect(toMapPoint({ type: "Point", coordinates: [77.209, 28.6139] })).toEqual({
      lng: 77.209,
      lat: 28.6139,
    });
  });

  test("accepts the extremes of the valid range", () => {
    expect(toMapPoint({ type: "Point", coordinates: [-180, -90] })).toEqual({
      lng: -180,
      lat: -90,
    });
    expect(toMapPoint({ type: "Point", coordinates: [180, 90] })).toEqual({
      lng: 180,
      lat: 90,
    });
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "Point"],
    ["wrong type", { type: "LineString", coordinates: [1, 2] }],
    ["no coordinates", { type: "Point" }],
    ["empty coordinates (a Mongoose default)", { coordinates: [] }],
    ["one coordinate", { type: "Point", coordinates: [10] }],
    ["strings", { type: "Point", coordinates: ["10", "20"] }],
    ["NaN", { type: "Point", coordinates: [NaN, 20] }],
    ["Infinity", { type: "Point", coordinates: [10, Infinity] }],
    ["longitude out of range", { type: "Point", coordinates: [181, 0] }],
    ["latitude out of range", { type: "Point", coordinates: [0, 91] }],
    ["swapped lat/lng out of range", { type: "Point", coordinates: [28.6, 200] }],
  ])("returns null for %s", (_name, geometry) => {
    expect(toMapPoint(geometry)).toBeNull();
  });
});

// ---- P06-T02: the approximate public point ----
const {
  approximatePoint,
  publicPointOf,
  distanceMeters,
  configureLocationSecret,
  offsetFor,
  MIN_OFFSET_M,
  MAX_OFFSET_M,
  PUBLIC_AREA_RADIUS_M,
} = require("../../src/utils/geo");

const DELHI = { type: "Point", coordinates: [77.20931, 28.61391] };
const ID = "64b0000000000000000000a1";
const SECRET = "a-test-secret-of-at-least-16-chars";
const distance = (precise, approx) =>
  distanceMeters(toMapPoint(precise), toMapPoint(approx));
const ids = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(24, "0"));

describe("approximatePoint", () => {
  test("is 300 to 800 metres from the precise point, for every id", () => {
    let min = Infinity;
    let max = 0;
    for (const id of ids(3000)) {
      const d = distance(DELHI, approximatePoint(DELHI, id, { secret: SECRET }));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    expect(min).toBeGreaterThanOrEqual(MIN_OFFSET_M);
    expect(max).toBeLessThanOrEqual(MAX_OFFSET_M);
    expect(min).toBeLessThan(330); // the whole range is used, not a narrow band
    expect(max).toBeGreaterThan(770);
  });

  test("the same listing always gets the same public point (reloading cannot average it out)", () => {
    const first = approximatePoint(DELHI, ID, { secret: SECRET });
    for (let i = 0; i < 50; i += 1) {
      expect(approximatePoint(DELHI, ID, { secret: SECRET })).toEqual(first);
    }
  });

  test("different listings at the same spot get different public points", () => {
    const points = new Set(ids(200).map((id) => JSON.stringify(approximatePoint(DELHI, id, { secret: SECRET }))));
    expect(points.size).toBeGreaterThan(190);
  });

  test("every direction is used (the offset is not biased to one side)", () => {
    const quadrants = new Set();
    for (const id of ids(400)) {
      const [lng, lat] = approximatePoint(DELHI, id, { secret: SECRET }).coordinates;
      quadrants.add(`${lng > DELHI.coordinates[0]}${lat > DELHI.coordinates[1]}`);
    }
    expect(quadrants.size).toBe(4);
  });

  test("it depends on the secret: the public id alone cannot undo it", () => {
    const a = approximatePoint(DELHI, ID, { secret: SECRET });
    const b = approximatePoint(DELHI, ID, { secret: "a-different-secret-also-16-chars" });
    expect(a).not.toEqual(b);
    // Someone who knows the id and the algorithm but not the secret guesses another offset:
    // subtracting a wrong offset lands elsewhere than the real precise point.
    const guess = offsetFor(ID, "guess-without-the-real-secret-1234");
    const real = offsetFor(ID, SECRET);
    expect(Math.abs(guess.bearing - real.bearing) + Math.abs(guess.meters - real.meters)).toBeGreaterThan(0);
  });

  test("the configured secret is used when none is passed, and changing it changes the point", () => {
    configureLocationSecret("first-configured-secret-1234567890");
    const one = approximatePoint(DELHI, ID);
    configureLocationSecret("second-configured-secret-123456789");
    const two = approximatePoint(DELHI, ID);
    expect(one).not.toEqual(two);
    expect(distance(DELHI, one)).toBeGreaterThanOrEqual(MIN_OFFSET_M);
    expect(() => configureLocationSecret("short")).toThrow(TypeError);
    expect(() => configureLocationSecret(undefined)).toThrow(TypeError);
  });

  test("works at the poles and across the antimeridian, and stays in range", () => {
    const places = [
      [179.9999, 0],
      [-179.9999, 10],
      [180, 45],
      [-180, -45],
      [10, 89.9999],
      [10, -89.9999],
      [0, 90],
      [0, -90],
      [0, 0],
    ];
    for (const [lng, lat] of places) {
      for (const id of ids(80)) {
        const point = approximatePoint({ type: "Point", coordinates: [lng, lat] }, id, { secret: SECRET });
        const [outLng, outLat] = point.coordinates;
        expect(outLng).toBeGreaterThanOrEqual(-180);
        expect(outLng).toBeLessThan(180.0000001);
        expect(outLat).toBeGreaterThanOrEqual(-90);
        expect(outLat).toBeLessThanOrEqual(90);
        expect(toMapPoint(point)).not.toBeNull();
        expect(Math.abs(distance({ type: "Point", coordinates: [lng, lat] }, point) - 550)).toBeLessThanOrEqual(251);
      }
    }
  });

  test("a point near the antimeridian can land on the other side with the right longitude", () => {
    const seen = new Set();
    for (const id of ids(200)) {
      const [lng] = approximatePoint({ type: "Point", coordinates: [179.9995, 0] }, id, { secret: SECRET }).coordinates;
      seen.add(lng > 0 ? "east" : "west");
    }
    expect(seen.size).toBe(2);
  });

  test("unusable input gives null, never a wrong point", () => {
    for (const geometry of [undefined, null, {}, { type: "Point" }, { type: "Point", coordinates: [] }, { type: "Point", coordinates: [200, 0] }]) {
      expect(approximatePoint(geometry, ID, { secret: SECRET })).toBeNull();
    }
    for (const id of [undefined, null, ""]) {
      expect(approximatePoint(DELHI, id, { secret: SECRET })).toBeNull();
    }
  });

  test("coordinates are rounded to 5 decimals (about 1 metre)", () => {
    for (const id of ids(100)) {
      for (const value of approximatePoint(DELHI, id, { secret: SECRET }).coordinates) {
        expect(Number(value.toFixed(5))).toBe(value);
      }
    }
  });
});

describe("publicPointOf", () => {
  test("uses the stored public point when there is one", () => {
    const listing = { _id: ID, geometry: DELHI, publicGeometry: { type: "Point", coordinates: [77.2, 28.6] } };
    expect(publicPointOf(listing)).toEqual({ lng: 77.2, lat: 28.6 });
  });

  test("computes it from the precise point for a listing saved before this existed", () => {
    const point = publicPointOf({ _id: ID, geometry: DELHI });
    expect(point).not.toBeNull();
    expect(point).not.toEqual({ lng: 77.20931, lat: 28.61391 });
    expect(distanceMeters(point, { lng: 77.20931, lat: 28.61391 })).toBeGreaterThanOrEqual(MIN_OFFSET_M);
  });

  test("never returns the precise point, and returns null when there is nothing to show", () => {
    expect(publicPointOf({ _id: ID, geometry: DELHI })).not.toEqual(toMapPoint(DELHI));
    for (const bad of [null, undefined, {}, { _id: ID }, { geometry: DELHI }, { _id: ID, geometry: { type: "Point", coordinates: [] } }]) {
      expect(publicPointOf(bad)).toBeNull();
    }
  });

  test("reads a Mongoose-style document through get()", () => {
    const values = { _id: ID, "geometry.type": "Point", "geometry.coordinates": [77.20931, 28.61391] };
    const point = publicPointOf({ get: (path) => values[path] });
    expect(point).not.toBeNull();
    expect(point).not.toEqual({ lng: 77.20931, lat: 28.61391 });
  });
});

describe("PUBLIC_AREA_RADIUS_M (P06-T03)", () => {
  test("is larger than the largest offset, so the drawn circle always contains the real point", () => {
    expect(PUBLIC_AREA_RADIUS_M).toBeGreaterThan(MAX_OFFSET_M);
  });
});
