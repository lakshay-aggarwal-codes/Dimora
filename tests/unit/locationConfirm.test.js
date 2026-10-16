// P04-T04: the remembered look-up that a location confirmation must match.
const {
  addressKey,
  rememberLookup,
  takeLookup,
  TTL_MS,
} = require("../../src/services/locationConfirm");

const ADDRESS = {
  line1: "12 Beach Road",
  city: "Goa",
  state: "Goa",
  country: "India",
  postalCode: "403001",
};
const FOUND = {
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
  placeName: "Panaji, Goa, India",
};
const T0 = 1_000_000;

test("the key depends on the listing and every address field, ignoring surrounding spaces", () => {
  const key = addressKey("L1", ADDRESS);
  expect(addressKey("L1", { ...ADDRESS, line1: "  12 Beach Road " })).toBe(key);
  expect(addressKey("L2", ADDRESS)).not.toBe(key);
  for (const field of Object.keys(ADDRESS)) {
    expect(addressKey("L1", { ...ADDRESS, [field]: "changed" })).not.toBe(key);
  }
  expect(addressKey("L1", { line1: "a", city: "b" })).toMatch(/^[0-9a-f]{64}$/);
});

test("the remembered point comes back for the same listing and address, once", () => {
  const session = {};
  rememberLookup(session, "L1", ADDRESS, FOUND, T0);
  const taken = takeLookup(session, "L1", ADDRESS, T0 + 1000);
  expect(taken.geometry).toEqual(FOUND.geometry);
  expect(taken.placeName).toBe("Panaji, Goa, India");
  expect(takeLookup(session, "L1", ADDRESS, T0 + 2000)).toBeNull();
  expect(session.pendingLocation).toBeUndefined();
});

test("a different address or listing gets nothing, and the memory is cleared", () => {
  const session = {};
  rememberLookup(session, "L1", ADDRESS, FOUND, T0);
  expect(takeLookup(session, "L1", { ...ADDRESS, city: "Pune" }, T0)).toBeNull();
  expect(session.pendingLocation).toBeUndefined();

  rememberLookup(session, "L1", ADDRESS, FOUND, T0);
  expect(takeLookup(session, "L2", ADDRESS, T0)).toBeNull();
});

test("it expires after 15 minutes (exactly 15 is still fine)", () => {
  const session = {};
  rememberLookup(session, "L1", ADDRESS, FOUND, T0);
  expect(takeLookup(session, "L1", ADDRESS, T0 + TTL_MS)).not.toBeNull();
  rememberLookup(session, "L1", ADDRESS, FOUND, T0);
  expect(takeLookup(session, "L1", ADDRESS, T0 + TTL_MS + 1)).toBeNull();
  expect(TTL_MS).toBe(15 * 60 * 1000);
});

test("nothing remembered, no session, or a damaged entry give null", () => {
  expect(takeLookup({}, "L1", ADDRESS, T0)).toBeNull();
  expect(takeLookup(undefined, "L1", ADDRESS, T0)).toBeNull();
  expect(takeLookup({ pendingLocation: { key: addressKey("L1", ADDRESS) } }, "L1", ADDRESS, T0)).toBeNull();
});
