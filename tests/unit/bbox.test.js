// P06-T04: the map box of a search.
const { parseBbox, wrapLng } = require("../../src/utils/bbox");

const ok = (value) => {
  const result = parseBbox(value);
  expect(result.ok).toBe(true);
  return result.boxes;
};

describe("parseBbox", () => {
  test("a normal box is one box", () => {
    expect(ok("73.5,15.2,74.2,15.9")).toEqual([{ west: 73.5, south: 15.2, east: 74.2, north: 15.9 }]);
  });

  test("a box across the antimeridian is two boxes (wrapped input)", () => {
    expect(ok("170,-20,-170,-10")).toEqual([
      { west: 170, south: -20, east: 180, north: -10 },
      { west: -180, south: -20, east: -170, north: -10 },
    ]);
  });

  test("a box across the antimeridian is two boxes (unwrapped input, as Mapbox reports it)", () => {
    expect(ok("170,-20,190,-10")).toEqual([
      { west: 170, south: -20, east: 180, north: -10 },
      { west: -180, south: -20, east: -170, north: -10 },
    ]);
  });

  test("a box on the other side, -190 .. -170, is also two boxes", () => {
    expect(ok("-190,0,-170,5")).toEqual([
      { west: 170, south: 0, east: 180, north: 5 },
      { west: -180, south: 0, east: -170, north: 5 },
    ]);
  });

  test("zoomed right out (360 degrees or more) covers every longitude", () => {
    expect(ok("-250,-60,250,70")).toEqual([{ west: -180, south: -60, east: 180, north: 70 }]);
    expect(ok("-180,-85,180,85")).toEqual([{ west: -180, south: -85, east: 180, north: 85 }]);
  });

  test("an edge exactly on 180 is one box that reaches 180", () => {
    expect(ok("-10,0,180,10")).toEqual([{ west: -10, south: 0, east: 180, north: 10 }]);
  });

  test.each([
    ["not a string", undefined],
    ["an array", ["1", "2", "3", "4"]],
    ["an object", { $gt: "1" }],
    ["three numbers", "1,2,3"],
    ["five numbers", "1,2,3,4,5"],
    ["an empty part", "1,,3,4"],
    ["text", "a,b,c,d"],
    ["Infinity", "1,2,Infinity,4"],
    ["south after north", "1,10,2,5"],
    ["latitude past the pole", "1,-91,2,5"],
    ["longitude absurdly large", "1,2,5000,4"],
  ])("refuses %s", (_name, value) => {
    const result = parseBbox(value);
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe("string");
  });

  test("wrapLng brings outside values into range and leaves inside values exactly as they are", () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(540)).toBe(-180);
    expect(wrapLng(180)).toBe(180);
    expect(wrapLng(-180)).toBe(-180);
    expect(wrapLng(74.2)).toBe(74.2);
  });
});
