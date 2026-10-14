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
