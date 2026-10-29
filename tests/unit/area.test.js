// P06-T05: the centre of a destination and the circle condition (no database).
const { areaCentre, areaCondition, RADII_KM, EARTH_RADIUS_KM } = require("../../src/services/area");

describe("areaCondition", () => {
  test("a $centerSphere on the PUBLIC point, centre as [lng, lat], radius in radians", () => {
    const c = areaCondition({ lng: 73.8, lat: 15.5 }, 25);
    expect(Object.keys(c)).toEqual(["publicGeometry"]); // never the precise `geometry`
    const sphere = c.publicGeometry.$geoWithin.$centerSphere;
    expect(sphere[0]).toEqual([73.8, 15.5]);
    expect(sphere[1]).toBeCloseTo(25 / EARTH_RADIUS_KM, 10);
  });

  test("the choices are 5, 10, 25 and 50 km", () => {
    expect([...RADII_KM]).toEqual([5, 10, 25, 50]);
  });
});

describe("areaCentre", () => {
  const model = (rows) => {
    const calls = [];
    return { calls, aggregate: async (pipeline) => (calls.push(pipeline), rows) };
  };

  test("matches the destination text among public stays with a public point, and averages the public coordinates", async () => {
    const Listing = model([{ _id: null, lng: 73.8, lat: 15.5, count: 4 }]);
    await expect(areaCentre(Listing, "Goa")).resolves.toEqual({ lng: 73.8, lat: 15.5, count: 4 });
    const [match, group] = Listing.calls[0];
    expect(match.$match["publicGeometry.type"]).toBe("Point");
    expect(match.$match.status).toBeDefined(); // only public listings (publicListingFilter)
    expect(match.$match.$and).toHaveLength(1); // the destination text clause
    const text = JSON.stringify(group);
    expect(text).toContain("$publicGeometry.coordinates");
    expect(text).not.toMatch(/"\$geometry\./); // the precise point is never read
  });

  test("no matching stay, or no usable numbers: null", async () => {
    await expect(areaCentre(model([]), "Nowhere")).resolves.toBeNull();
    await expect(areaCentre(model([{ lng: null, lat: 1, count: 1 }]), "x")).resolves.toBeNull();
    await expect(areaCentre(model([{ lng: NaN, lat: 1, count: 1 }]), "x")).resolves.toBeNull();
    await expect(areaCentre(model(undefined), "x")).resolves.toBeNull();
  });
});
