// P06-T02: who may see the precise location (no database).
const { mayViewPreciseLocation, preciseLocationFor } = require("../../src/services/locationAccess");

const HOST = { _id: "host1", role: "member" };
const GUEST = { _id: "guest1", role: "member" };
const OTHER = { _id: "other1", role: "member" };
const ADMIN = { _id: "admin1", role: "admin" };
const LISTING = {
  _id: "L1",
  owner: "host1",
  address: { line1: "12 Beach Road" },
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
};
const reservation = (extra = {}) => ({ status: "confirmed", guest: "guest1", listing: "L1", ...extra });

describe("mayViewPreciseLocation", () => {
  test("the host and admins always may", () => {
    expect(mayViewPreciseLocation({ viewer: HOST, listing: LISTING })).toBe(true);
    expect(mayViewPreciseLocation({ viewer: ADMIN, listing: LISTING })).toBe(true);
  });

  test("a guest with a confirmed (or completed) reservation of this listing may", () => {
    expect(mayViewPreciseLocation({ viewer: GUEST, listing: LISTING, reservation: reservation() })).toBe(true);
    expect(mayViewPreciseLocation({ viewer: GUEST, listing: LISTING, reservation: reservation({ status: "completed" }) })).toBe(true);
  });

  test("a reservation that is not confirmed does not count", () => {
    for (const status of ["pending", "held", "expired", "cancelled", "rejected", "", undefined]) {
      expect(mayViewPreciseLocation({ viewer: GUEST, listing: LISTING, reservation: reservation({ status }) })).toBe(false);
    }
  });

  test("somebody else's reservation, or one for another listing, does not count", () => {
    expect(mayViewPreciseLocation({ viewer: OTHER, listing: LISTING, reservation: reservation() })).toBe(false);
    expect(mayViewPreciseLocation({ viewer: GUEST, listing: LISTING, reservation: reservation({ listing: "L2" }) })).toBe(false);
    expect(mayViewPreciseLocation({ viewer: GUEST, listing: LISTING, reservation: reservation({ guest: undefined }) })).toBe(false);
  });

  test("anonymous visitors, members with no reservation, and missing input may not", () => {
    expect(mayViewPreciseLocation({ viewer: undefined, listing: LISTING, reservation: reservation() })).toBe(false);
    expect(mayViewPreciseLocation({ viewer: OTHER, listing: LISTING })).toBe(false);
    expect(mayViewPreciseLocation({ viewer: GUEST })).toBe(false);
    expect(mayViewPreciseLocation()).toBe(false);
  });

  test("works with populated documents (ids inside objects)", () => {
    const listing = { ...LISTING, owner: { _id: "host1" } };
    expect(mayViewPreciseLocation({ viewer: HOST, listing })).toBe(true);
    const res = reservation({ guest: { _id: "guest1" }, listing: { _id: "L1" } });
    expect(mayViewPreciseLocation({ viewer: GUEST, listing, reservation: res })).toBe(true);
  });
});

describe("preciseLocationFor", () => {
  test("gives the precise point and the street address to those who may see them", () => {
    expect(preciseLocationFor({ viewer: GUEST, listing: LISTING, reservation: reservation() })).toEqual({
      point: { lng: 73.8, lat: 15.5 },
      addressLine: "12 Beach Road",
    });
  });

  test("gives nothing to everybody else", () => {
    expect(preciseLocationFor({ viewer: OTHER, listing: LISTING, reservation: reservation() })).toBeNull();
    expect(preciseLocationFor({ viewer: GUEST, listing: LISTING, reservation: reservation({ status: "pending" }) })).toBeNull();
    expect(preciseLocationFor({ listing: LISTING })).toBeNull();
  });

  test("a listing with no usable point gives null; a missing street address is an empty string", () => {
    expect(preciseLocationFor({ viewer: HOST, listing: { ...LISTING, geometry: { type: "Point", coordinates: [] } } })).toBeNull();
    expect(preciseLocationFor({ viewer: HOST, listing: { ...LISTING, address: {} } }).addressLine).toBe("");
  });

  test("reads a Mongoose-style document through get()", () => {
    const values = { "geometry.type": "Point", "geometry.coordinates": [73.8, 15.5], "address.line1": "12 Beach Road" };
    const doc = { owner: "host1", get: (p) => values[p] };
    expect(preciseLocationFor({ viewer: HOST, listing: doc }).point).toEqual({ lng: 73.8, lat: 15.5 });
  });
});
