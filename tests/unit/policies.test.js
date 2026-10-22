// P02-T06: the authorization matrix. This table is the single place that
// proves who may do what; every later task adds its actions and rows here.
// Policies are pure functions, so no app and no database are involved.
const { ObjectId } = require("mongoose").Types;
const { can, actions } = require("../../src/policies");
const { sameId, idOf } = require("../../src/policies/shared");

const ownerId = new ObjectId();
const authorId = new ObjectId();
const guestId = new ObjectId();

const user = (extra) => ({ _id: new ObjectId(), role: "member", ...extra });

const people = {
  anonymous: undefined,
  "other member": user(),
  "listing owner": { _id: ownerId, role: "member", status: "active" },
  "review author": { _id: authorId, role: "member", status: "active" },
  "guest of the booking": { _id: guestId, role: "member", status: "active" },
  admin: user({ role: "admin", status: "active" }),
  "legacy user (no status field)": user(),
  "suspended owner": { _id: ownerId, role: "member", status: "suspended" },
  "suspended guest": { _id: guestId, role: "member", status: "suspended" },
  "suspended admin": user({ role: "admin", status: "suspended" }),
  "deleted owner": { _id: ownerId, role: "member", status: "deleted" },
};

const listing = { owner: ownerId };
const review = { author: authorId };
const reservation = { guest: guestId, host: ownerId };

// [action, resource, { person: expected }] - people not listed must be denied.
const MATRIX = [
  [
    "listing:create",
    undefined,
    {
      "other member": true,
      "listing owner": true,
      "review author": true,
      "guest of the booking": true,
      admin: true,
      "legacy user (no status field)": true,
    },
  ],
  ["listing:edit", listing, { "listing owner": true }],
  ["listing:delete", listing, { "listing owner": true, admin: true }],
  [
    "review:create",
    undefined,
    {
      "other member": true,
      "listing owner": true,
      "review author": true,
      "guest of the booking": true,
      admin: true,
      "legacy user (no status field)": true,
    },
  ],
  ["review:delete", review, { "review author": true, admin: true }],
  [
    "reservation:view",
    reservation,
    {
      "listing owner": true, // the host of the booking
      "guest of the booking": true,
      admin: true,
    },
  ],
  ["admin:access", undefined, { admin: true }],
];

describe("authorization matrix", () => {
  for (const [action, resource, allowed] of MATRIX) {
    describe(action, () => {
      for (const [who, person] of Object.entries(people)) {
        const expected = allowed[who] === true;
        test(`${who} -> ${expected ? "allowed" : "denied"}`, () => {
          expect(can(action, person, resource)).toBe(expected);
        });
      }
    });
  }

  test("the matrix covers every registered action", () => {
    expect(MATRIX.map(([action]) => action).sort()).toEqual(actions().sort());
  });
});

describe("policy edge cases", () => {
  test("a listing without an owner can be edited by nobody, removed only by an admin", () => {
    const orphan = { owner: undefined };
    expect(can("listing:edit", people["other member"], orphan)).toBe(false);
    expect(can("listing:edit", people.admin, orphan)).toBe(false);
    expect(can("listing:delete", people["other member"], orphan)).toBe(false);
    expect(can("listing:delete", people.admin, orphan)).toBe(true);
  });

  test("a review without an author can be removed only by an admin", () => {
    const orphan = { author: null };
    expect(can("review:delete", people["other member"], orphan)).toBe(false);
    expect(can("review:delete", people.admin, orphan)).toBe(true);
  });

  test("a missing resource is denied, not a crash", () => {
    expect(can("listing:edit", people["listing owner"], null)).toBe(false);
    expect(can("listing:delete", people.admin, undefined)).toBe(false);
    expect(can("review:delete", people.admin, null)).toBe(false);
  });

  test("owner may be an ObjectId, a populated document or a string", () => {
    const me = people["listing owner"];
    expect(can("listing:edit", me, { owner: ownerId })).toBe(true);
    expect(can("listing:edit", me, { owner: { _id: ownerId } })).toBe(true);
    expect(can("listing:edit", me, { owner: String(ownerId) })).toBe(true);
    expect(can("listing:edit", me, { owner: new ObjectId() })).toBe(false);
  });

  test("a user object without an id is denied", () => {
    expect(can("listing:create", { role: "admin" }, undefined)).toBe(false);
    expect(can("listing:delete", { role: "admin" }, listing)).toBe(false);
  });

  test("an unknown action throws instead of silently allowing or denying", () => {
    expect(() => can("listing:fly", people.admin, listing)).toThrow(
      /Unknown policy action/,
    );
  });

  test("sameId / idOf never match a missing id", () => {
    expect(sameId(undefined, undefined)).toBe(false);
    expect(sameId(null, ownerId)).toBe(false);
    expect(sameId(ownerId, String(ownerId))).toBe(true);
    expect(idOf(undefined)).toBeNull();
  });
});

describe("reservation:view edge cases (P09-T01)", () => {
  const me = people["guest of the booking"];
  test("guest and host may be ObjectIds, populated documents or strings", () => {
    expect(can("reservation:view", me, { guest: { _id: guestId }, host: ownerId })).toBe(true);
    expect(can("reservation:view", me, { guest: String(guestId), host: ownerId })).toBe(true);
    expect(can("reservation:view", people["listing owner"], { guest: guestId, host: { _id: ownerId } })).toBe(true);
  });
  test("a booking without a guest or host is visible only to an admin", () => {
    expect(can("reservation:view", me, { guest: null, host: null })).toBe(false);
    expect(can("reservation:view", people["other member"], { host: undefined })).toBe(false);
    expect(can("reservation:view", people.admin, { guest: null, host: null })).toBe(true);
  });
  test("a missing booking is denied, not a crash", () => {
    expect(can("reservation:view", people.admin, null)).toBe(false);
    expect(can("reservation:view", me, undefined)).toBe(false);
  });
});
