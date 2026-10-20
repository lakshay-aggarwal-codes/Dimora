// P14-T02: the user-admin service with the models stubbed (no database).
const { ObjectId } = require("mongoose").Types;
const session = require("express-session");
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const userAdmin = require("../../src/services/userAdmin");

const { suspendUser, reinstateUser, destroyUserSessions, searchUsers, cleanReason, UserAdminError } =
  userAdmin;

afterEach(() => jest.restoreAllMocks());

const account = (extra) => ({
  _id: new ObjectId(),
  username: "ann",
  role: "member",
  status: "active",
  ...extra,
});
// find...().select().sort()... all resolve to the value.
const chain = (value) => {
  const c = {};
  for (const m of ["select", "sort", "skip", "limit", "lean"]) c[m] = () => c;
  c.then = (res, rej) => Promise.resolve(value).then(res, rej);
  return c;
};

function stub({ target, admins = 2, modified = 1, hidden = 3 } = {}) {
  const findById = jest.spyOn(User, "findById").mockReturnValue(chain(target ?? null));
  const countDocuments = jest.spyOn(User, "countDocuments").mockResolvedValue(admins);
  const updateOne = jest.spyOn(User, "updateOne").mockResolvedValue({ modifiedCount: modified });
  const updateMany = jest
    .spyOn(Listing, "updateMany")
    .mockResolvedValue({ modifiedCount: hidden }); // the one Listing update of each action
  return { findById, countDocuments, updateOne, updateMany };
}

// A store like express-session's MemoryStore, with real session JSON.
function memoryStoreWith(sessions) {
  const store = new session.MemoryStore();
  for (const [sid, user] of Object.entries(sessions)) {
    store.sessions[sid] = JSON.stringify({
      cookie: { originalMaxAge: 1000, expires: null },
      passport: { user },
      csrfToken: "t",
    });
  }
  return store;
}
const noStoreCall = () => ({ all: jest.fn(), destroy: jest.fn() });

describe("cleanReason", () => {
  test.each([undefined, null, 5, "", "   ", "abcd", " ab "])("refuses %p", (value) => {
    expect(() => cleanReason(value)).toThrow(UserAdminError);
  });
  test("refuses more than 500 characters, trims the rest", () => {
    expect(() => cleanReason("x".repeat(501))).toThrow(UserAdminError);
    expect(cleanReason("  spam listings  ")).toBe("spam listings");
  });
});

describe("suspendUser", () => {
  const admin = account({ username: "boss", role: "admin" });

  test("a missing reason changes nothing and reads nothing", async () => {
    const s = stub({ target: account() });
    await expect(suspendUser({ admin, id: String(new ObjectId()), reason: " ", store: noStoreCall() })).rejects.toThrow(
      /reason/i,
    );
    expect(s.findById).not.toHaveBeenCalled();
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("a malformed or unknown id is refused", async () => {
    const s = stub({ target: null });
    await expect(suspendUser({ admin, id: "nope", reason: "spam listings", store: noStoreCall() })).rejects.toThrow(
      /does not exist/,
    );
    await expect(
      suspendUser({ admin, id: String(new ObjectId()), reason: "spam listings", store: noStoreCall() }),
    ).rejects.toThrow(/does not exist/);
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("an admin cannot suspend themselves", async () => {
    const s = stub({ target: admin });
    await expect(
      suspendUser({ admin, id: String(admin._id), reason: "testing it out", store: noStoreCall() }),
    ).rejects.toThrow(/your own account/);
    expect(s.updateOne).not.toHaveBeenCalled();
    expect(s.updateMany).not.toHaveBeenCalled();
  });

  test.each(["suspended", "deleted"])("a %s account cannot be suspended again", async (status) => {
    const target = account({ status });
    const s = stub({ target });
    await expect(
      suspendUser({ admin, id: String(target._id), reason: "spam listings", store: noStoreCall() }),
    ).rejects.toThrow(new RegExp(`already ${status}`));
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("the last admin cannot be suspended", async () => {
    const target = account({ role: "admin" });
    const s = stub({ target, admins: 1 });
    await expect(
      suspendUser({ admin, id: String(target._id), reason: "spam listings", store: noStoreCall() }),
    ).rejects.toThrow(/last admin/);
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("another admin can be suspended while two admins exist", async () => {
    const target = account({ role: "admin", username: "second" });
    stub({ target, admins: 2 });
    const store = memoryStoreWith({});
    const out = await suspendUser({ admin, id: String(target._id), reason: "left the team", store });
    expect(out.details.role).toBe("admin");
  });

  test("a change by someone else in between is refused, listings and sessions untouched", async () => {
    const target = account();
    const s = stub({ target, modified: 0 });
    const store = noStoreCall();
    await expect(suspendUser({ admin, id: String(target._id), reason: "spam listings", store })).rejects.toThrow(
      /changed while/,
    );
    expect(s.updateMany).not.toHaveBeenCalled();
    expect(store.all).not.toHaveBeenCalled();
  });

  test("suspends, hides published listings, deletes only that user's sessions", async () => {
    const target = account({ username: "ann" });
    const s = stub({ target, hidden: 3 });
    const store = memoryStoreWith({ a1: "ann", a2: "ann", b1: "bob", c1: "ann2" });

    const out = await suspendUser({ admin, id: String(target._id), reason: "  repeated fake listings ", store });

    expect(s.updateOne).toHaveBeenCalledWith({ _id: target._id, status: "active" }, { $set: { status: "suspended" } });
    expect(s.updateMany).toHaveBeenCalledWith(
      { owner: target._id, status: "published", deletedAt: null },
      { $set: { status: "suspended", hiddenByOwnerSuspension: true } },
    );
    expect(Object.keys(store.sessions).sort()).toEqual(["b1", "c1"]);
    expect(out.reason).toBe("repeated fake listings");
    expect(out.details).toMatchObject({
      username: "ann",
      from: "active",
      to: "suspended",
      listingsHidden: 3,
      sessionsDeleted: 2,
      reservationsPendingDeclined: 0,
      reservationsConfirmedFlagged: 0,
    });
  });

  test("the audit details hold no email, hash or salt", async () => {
    const target = account({ email: "ann@example.com", hash: "h", salt: "s" });
    stub({ target });
    const out = await suspendUser({ admin, id: String(target._id), reason: "spam listings", store: memoryStoreWith({}) });
    expect(JSON.stringify(out.details)).not.toMatch(/example\.com|"hash"|"salt"/);
  });
});

describe("reinstateUser", () => {
  test.each(["active", "deleted"])("a %s account cannot be reinstated", async (status) => {
    const target = account({ status });
    const s = stub({ target });
    await expect(reinstateUser({ id: String(target._id), reason: "appeal accepted" })).rejects.toThrow(
      /Only a suspended account/,
    );
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("a reason is required", async () => {
    const s = stub({ target: account({ status: "suspended" }) });
    await expect(reinstateUser({ id: String(new ObjectId()), reason: "" })).rejects.toThrow(/reason/i);
    expect(s.updateOne).not.toHaveBeenCalled();
  });

  test("reactivates and restores only the listings the suspension hid", async () => {
    const target = account({ status: "suspended" });
    const s = stub({ target, hidden: 2 });
    const out = await reinstateUser({ id: String(target._id), reason: "appeal accepted" });
    expect(s.updateOne).toHaveBeenCalledWith({ _id: target._id, status: "suspended" }, { $set: { status: "active" } });
    expect(s.updateMany).toHaveBeenCalledWith(
      { owner: target._id, status: "suspended", hiddenByOwnerSuspension: true, deletedAt: null },
      { $set: { status: "published" }, $unset: { hiddenByOwnerSuspension: "" } },
    );
    expect(out.details).toMatchObject({ from: "suspended", to: "active", listingsRestored: 2 });
  });
});

describe("destroyUserSessions", () => {
  test("MemoryStore: only that username's sessions go; none left over", async () => {
    const store = memoryStoreWith({ s1: "ann", s2: "bob", s3: "ann" });
    expect(await destroyUserSessions(store, "ann")).toBe(2);
    expect(Object.keys(store.sessions)).toEqual(["s2"]);
  });

  test("MongoStore: one deleteMany whose pattern matches that user's stored JSON only", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 4 });
    const store = { collectionP: Promise.resolve({ deleteMany }) };
    const names = ["ann", "a.n", "o'brien", 'we"ird\\name', "ann2"];
    for (const name of names) {
      deleteMany.mockClear();
      await destroyUserSessions(store, name);
      const rx = new RegExp(deleteMany.mock.calls[0][0].session.$regex);
      const stored = (user) =>
        JSON.stringify({ cookie: {}, passport: { user }, csrfToken: "t" });
      expect(rx.test(stored(name))).toBe(true);
      for (const other of names.filter((n) => n !== name)) {
        expect(rx.test(stored(other))).toBe(false);
      }
      expect(rx.test(JSON.stringify({ cookie: {}, csrfToken: "t" }))).toBe(false); // anonymous
    }
  });

  test("MongoStore: returns the count the driver reports", async () => {
    const store = { collectionP: Promise.resolve({ deleteMany: async () => ({ deletedCount: 4 }) }) };
    expect(await destroyUserSessions(store, "ann")).toBe(4);
  });

  test("a store that cannot delete by user is an error, not a silent skip", async () => {
    await expect(destroyUserSessions({}, "ann")).rejects.toThrow(/cannot delete/);
    await expect(destroyUserSessions(undefined, "ann")).rejects.toThrow(/no session store/);
  });
});

describe("searchUsers", () => {
  function listStub(total = 45) {
    const countDocuments = jest.spyOn(User, "countDocuments").mockResolvedValue(total);
    const find = jest.spyOn(User, "find").mockReturnValue(chain([]));
    return { countDocuments, find };
  }

  test("the text is matched as plain text: pattern characters are escaped", async () => {
    const { find } = listStub();
    await searchUsers({ q: "a.*(b" });
    const [rxUsername] = find.mock.calls[0][0].$or.map((c) => Object.values(c)[0]);
    expect(rxUsername.test("a.*(b")).toBe(true);
    expect(rxUsername.test("axxxb")).toBe(false);
    expect(rxUsername.flags).toContain("i");
  });

  test("searches username, email and display name", async () => {
    const { find } = listStub();
    await searchUsers({ q: "ann" });
    expect(find.mock.calls[0][0].$or.map((c) => Object.keys(c)[0])).toEqual(["username", "email", "displayName"]);
  });

  test("only a known status filters; anything else is ignored", async () => {
    const { find } = listStub();
    await searchUsers({ status: "suspended" });
    expect(find.mock.calls[0][0]).toEqual({ status: "suspended" });
    await searchUsers({ status: "$ne" });
    expect(find.mock.calls[1][0]).toEqual({});
    await searchUsers({ status: ["suspended"], q: ["a", "b"] });
    expect(find.mock.calls[2][0]).toEqual({});
  });

  test("an over-long search is cut and the page is kept in range", async () => {
    listStub(45);
    const out = await searchUsers({ q: "x".repeat(500), page: "99" });
    expect(out.q).toHaveLength(100);
    expect(out.totalPages).toBe(3);
    expect(out.page).toBe(3);
    expect((await searchUsers({ page: "-1" })).page).toBe(1);
  });
});
