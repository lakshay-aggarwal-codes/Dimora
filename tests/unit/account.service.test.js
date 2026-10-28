// P02-T04: password change and account deletion, with in-memory fakes.
const { ObjectId } = require("mongoose").Types;
const account = require("../../src/services/account");
const { parseDateOnly } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
// 20 Oct 2026, 11:30 in Kolkata: today is 2026-10-20.
const NOW = new Date("2026-10-20T06:00:00Z");
const HOUR = 3600000;

const makeUser = (extra = {}) => {
  const user = {
    _id: new ObjectId(),
    username: "ann",
    email: "ann@example.com",
    displayName: "Ann Lee",
    role: "member",
    status: "active",
    bio: "I like boats",
    avatar: { url: "https://img/ann.jpg", filename: "dimora/ann" },
    emailVerifiedAt: new Date("2026-01-01"),
    hash: "oldhash",
    salt: "oldsalt",
    attempts: 0,
    correct: "pa55word-long",
    ...extra,
  };
  user.authenticate = async (password) =>
    password === user.correct
      ? { user, error: null }
      : {
          user: false,
          error: Object.assign(new Error("bad"), {
            name: user.failWith || "IncorrectPasswordError",
          }),
        };
  return user;
};

function world({
  user = makeUser(),
  reservations = [],
  listings = [],
  admins = 1,
} = {}) {
  const calls = {
    listings: [],
    users: [],
    deleted: [],
    images: [],
    reports: [],
  };
  const matches = (r, f) =>
    Object.entries(f).every(([k, v]) => {
      if (v && typeof v === "object" && "$gt" in v) return r[k] > v.$gt;
      return String(r[k]) === String(v);
    });
  const ReservationModel = {
    countDocuments: jest.fn(
      async (f) => reservations.filter((r) => matches(r, f)).length,
    ),
  };
  const store = { listings: listings.map((l) => ({ ...l })) };
  const ListingModel = {
    find: jest.fn((f) => ({
      select: () => ({
        lean: async () =>
          store.listings.filter(
            (l) => String(l.owner) === String(f.owner) && l.status === f.status,
          ),
      }),
    })),
    updateMany: jest.fn(async (f, u) => {
      calls.listings.push([f, u]);
      for (const l of store.listings)
        if (
          f._id.$in.some((id) => String(id) === String(l._id)) &&
          l.status === f.status
        )
          Object.assign(l, u.$set);
    }),
  };
  const UserModel = {
    countDocuments: jest.fn(async () => admins),
    findOneAndUpdate: jest.fn(async (f, u) => {
      if (String(f._id) !== String(user._id) || user.status !== f.status)
        return null;
      calls.users.push(u);
      Object.assign(user, u.$set);
      for (const k of Object.keys(u.$unset || {})) delete user[k];
      return user;
    }),
  };
  const del = (name) => ({
    deleteMany: jest.fn(async (f) => calls.deleted.push([name, f])),
  });
  return {
    user,
    calls,
    store,
    ReservationModel,
    ListingModel,
    UserModel,
    deps: {
      ReservationModel,
      ListingModel,
      UserModel,
      WishlistModel: del("wishlist"),
      WishlistItemModel: del("wishlistItem"),
      SavedSearchModel: del("savedSearch"),
      NotificationModel: del("notification"),
      ReportModel: {
        updateMany: jest.fn(async (f, u) => calls.reports.push([f, u])),
      },
      deleteImage: jest.fn(async (name) => calls.images.push(name)),
    },
  };
}
const res = (over) => ({ _id: new ObjectId(), ...over });
const del = (w, over = {}) =>
  account.deleteAccount({
    user: w.user,
    password: "pa55word-long",
    now: NOW,
    ...w.deps,
    ...over,
  });
const codes = (blockers) => blockers.map((b) => b.code);

describe("deletionBlockers: the block / allow matrix", () => {
  const ME = makeUser();
  const stay = (over) =>
    res({
      guest: ME._id,
      host: new ObjectId(),
      status: "confirmed",
      checkOut: d("2026-10-25"),
      ...over,
    });
  const hosted = (over) =>
    res({
      host: ME._id,
      guest: new ObjectId(),
      status: "confirmed",
      checkOut: d("2026-10-25"),
      ...over,
    });
  const run = async (reservations, user = ME, admins = 1) =>
    account.deletionBlockers(user, {
      now: NOW,
      ...world({ user, reservations, admins }).deps,
    });

  test("nothing at all: allowed", async () =>
    expect(await run([])).toEqual([]));

  test.each([
    [
      "a confirmed stay as guest that has not ended",
      [stay()],
      ["guest_confirmed"],
    ],
    [
      "a stay that is in progress (check-out ahead)",
      [stay({ checkIn: d("2026-10-18"), checkOut: d("2026-10-21") })],
      ["guest_confirmed"],
    ],
    [
      "a request waiting for a host",
      [
        stay({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() + HOUR),
        }),
      ],
      ["guest_pending"],
    ],
    ["a confirmed stay at the member's place", [hosted()], ["host_confirmed"]],
    [
      "a request waiting for the member's answer",
      [
        hosted({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() + HOUR),
        }),
      ],
      ["host_pending"],
    ],
    [
      "all four",
      [
        stay(),
        stay({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() + HOUR),
        }),
        hosted(),
        hosted({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() + HOUR),
        }),
      ],
      ["guest_confirmed", "guest_pending", "host_confirmed", "host_pending"],
    ],
  ])("blocked by %s", async (_n, reservations, expected) =>
    expect(codes(await run(reservations))).toEqual(expected),
  );

  test.each([
    ["a stay that ended yesterday", [stay({ checkOut: d("2026-10-20") })]],
    [
      "a completed stay",
      [stay({ status: "completed", checkOut: d("2026-09-01") })],
    ],
    [
      "a request whose hold ran out",
      [
        stay({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() - HOUR),
        }),
      ],
    ],
    [
      "declined, expired and cancelled bookings",
      ["declined", "expired", "cancelled_by_guest", "cancelled_by_host"].map(
        (status) => stay({ status }),
      ),
    ],
    [
      "somebody else's bookings",
      [
        res({
          guest: new ObjectId(),
          host: new ObjectId(),
          status: "confirmed",
          checkOut: d("2026-12-01"),
        }),
      ],
    ],
  ])("allowed with %s", async (_n, reservations) =>
    expect(await run(reservations)).toEqual([]),
  );

  test("the only administrator cannot delete the account; with another administrator it is allowed", async () => {
    const boss = makeUser({ role: "admin" });
    expect(codes(await run([], boss, 0))).toEqual(["last_admin"]);
    expect(await run([], boss, 1)).toEqual([]);
  });

  test("every blocker has a sentence the member can act on", async () => {
    const all = await run([
      stay(),
      stay({
        status: "pending",
        holdExpiresAt: new Date(NOW.getTime() + HOUR),
      }),
      hosted(),
      hosted({
        status: "pending",
        holdExpiresAt: new Date(NOW.getTime() + HOUR),
      }),
    ]);
    for (const b of all) expect(b.message.length).toBeGreaterThan(30);
    expect(all[0].message).toBe(
      "You have 1 confirmed stay that has not ended. Cancel it or wait until the stay is over.",
    );
  });
});

describe("deleteAccount", () => {
  test("the wrong password refuses and changes nothing", async () => {
    const w = world();
    await expect(del(w, { password: "nope" })).rejects.toMatchObject({
      code: "wrong_password",
      statusCode: 409,
    });
    expect(w.calls.users).toHaveLength(0);
    expect(w.user.status).toBe("active");
  });

  test("a locked account says so (the failed-attempt lock counts)", async () => {
    const w = world({ user: makeUser({ failWith: "TooManyAttemptsError" }) });
    await expect(del(w, { password: "nope" })).rejects.toMatchObject({
      code: "locked",
    });
  });

  test("an unexpected error from the password check is not reported as 'wrong password'", async () => {
    const w = world({ user: makeUser({ failWith: "MongoNetworkError" }) });
    await expect(del(w, { password: "nope" })).rejects.toMatchObject({
      name: "MongoNetworkError",
    });
  });

  test("a blocked account refuses with the blockers and leaves listings published", async () => {
    const user = makeUser();
    const listing = res({ owner: user._id, status: "published" });
    const w = world({
      user,
      listings: [listing],
      reservations: [
        res({ host: user._id, status: "confirmed", checkOut: d("2026-10-30") }),
      ],
    });
    const err = await del(w).catch((e) => e);
    expect(err).toMatchObject({
      code: "blocked",
      blockers: [expect.objectContaining({ code: "host_confirmed" })],
    });
    expect(w.store.listings[0].status).toBe("published");
    expect(w.calls.users).toHaveLength(0);
  });

  test("allowed: listings are unpublished, the account is anonymised, saved stays and notifications go, avatar is removed", async () => {
    const user = makeUser();
    const l1 = res({ owner: user._id, status: "published" });
    const l2 = res({ owner: user._id, status: "published" });
    const draft = res({ owner: user._id, status: "draft" });
    const w = world({ user, listings: [l1, l2, draft] });
    const done = await del(w);
    expect(done.unpublished).toBe(2);
    expect(w.store.listings.map((l) => l.status)).toEqual([
      "unpublished",
      "unpublished",
      "draft",
    ]);
    expect(w.calls.deleted.map(([name]) => name).sort()).toEqual([
      "notification",
      "savedSearch",
      "wishlist",
      "wishlistItem",
    ]);
    expect(
      w.calls.deleted.every(
        ([, f]) => String(f.owner || f.user) === String(user._id),
      ),
    ).toBe(true);
    expect(w.calls.reports[0][0]).toEqual({
      targetKind: "user",
      targetId: user._id,
    });
    expect(w.calls.reports[0][1]).toEqual({
      $set: { targetLabel: "Deleted user" },
    });
    expect(w.calls.images).toEqual(["dimora/ann"]);
  });

  test("anonymisation leaves no PII field: nothing of the old name, email, bio, avatar or credentials remains", async () => {
    const user = makeUser();
    const before = { ...user };
    const w = world({ user });
    await del(w);
    const text = JSON.stringify(
      Object.fromEntries(
        Object.entries(user).filter(([, v]) => typeof v !== "function"),
      ),
    );
    for (const secret of [
      before.username,
      before.email,
      before.displayName,
      before.bio,
      before.avatar.url,
      before.avatar.filename,
      before.hash,
      before.salt,
      "ann@example.com",
      "Ann Lee",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(user).toMatchObject({
      username: `deleted-${user._id}`,
      displayName: "Deleted user",
      email: `deleted-${user._id}@deleted.invalid`,
      bio: "",
      status: "deleted",
      emailVerifiedAt: null,
      attempts: 0,
    });
    expect(user.avatar).toBeUndefined();
    expect(user.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(user.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(user.role).toBe("member"); // not touched
  });

  test("the credentials left behind are random, different for every account, and not the password", async () => {
    const a = makeUser();
    const b = makeUser();
    await del(world({ user: a }));
    await del(world({ user: b }));
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  test("a booking that arrives after the listings were unpublished: refused, listings published again, account untouched", async () => {
    const user = makeUser();
    const listing = res({ owner: user._id, status: "published" });
    const w = world({ user, listings: [listing] });
    // the first check finds nothing; the second (after unpublishing) finds an instant booking
    let calls = 0;
    w.ReservationModel.countDocuments.mockImplementation(async (f) =>
      ++calls > 4 && f.host === user._id && f.status === "confirmed" ? 1 : 0,
    );
    const err = await del(w).catch((e) => e);
    expect(err).toMatchObject({ code: "blocked" });
    expect(w.store.listings[0].status).toBe("published");
    expect(w.user.status).toBe("active");
    expect(w.calls.users).toHaveLength(0);
  });

  test("a failure while anonymising puts the listings back", async () => {
    const user = makeUser();
    const listing = res({ owner: user._id, status: "published" });
    const w = world({ user, listings: [listing] });
    w.UserModel.findOneAndUpdate.mockRejectedValue(new Error("disk full"));
    await expect(del(w)).rejects.toThrow("disk full");
    expect(w.store.listings[0].status).toBe("published");
  });

  test("an account that was changed meanwhile (already deleted) is refused and listings restored", async () => {
    const user = makeUser();
    const w = world({
      user,
      listings: [res({ owner: user._id, status: "published" })],
    });
    user.status = "suspended"; // changed between the check and the update
    await expect(del(w)).rejects.toMatchObject({ code: "conflict" });
    expect(w.store.listings[0].status).toBe("published");
  });

  test("two deletions at the same moment: one succeeds", async () => {
    const user = makeUser();
    const w = world({ user });
    const results = await Promise.allSettled([del(w), del(w)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({
      code: "conflict",
    });
  });

  test("a failed image removal does not undo the deletion", async () => {
    const user = makeUser();
    const w = world({ user });
    w.deps.deleteImage.mockRejectedValue(new Error("cloudinary down"));
    await expect(del(w)).resolves.toMatchObject({ unpublished: 0 });
    expect(user.status).toBe("deleted");
  });

  test("a member with no avatar and no listings is simply anonymised", async () => {
    const user = makeUser({ avatar: undefined });
    const w = world({ user });
    await del(w);
    expect(w.deps.deleteImage).not.toHaveBeenCalled();
    expect(w.ListingModel.updateMany).not.toHaveBeenCalled();
  });
});

describe("anonymisedUpdate", () => {
  test("is built from the id only", () => {
    const id = new ObjectId();
    const u = account.anonymisedUpdate(id);
    expect(u.$set.username).toBe(`deleted-${id}`);
    expect(JSON.stringify(u)).not.toMatch(/@(example|gmail)/);
    expect(u.$unset).toEqual({ avatar: "" });
  });
});

describe("changePassword", () => {
  const user = (impl) => ({ changePassword: jest.fn(impl) });
  test("passes both passwords to the plugin", async () => {
    const u = user(async () => u);
    await account.changePassword({
      user: u,
      currentPassword: "old-password-1",
      newPassword: "new-password-2",
    });
    expect(u.changePassword).toHaveBeenCalledWith(
      "old-password-1",
      "new-password-2",
    );
  });
  test.each([
    [
      "IncorrectPasswordError",
      "wrong_password",
      "Your current password is not correct.",
    ],
    [
      "MissingPasswordError",
      "wrong_password",
      "Your current password is not correct.",
    ],
    [
      "AttemptTooSoonError",
      "locked",
      "Too many wrong passwords. Wait a few minutes and try again.",
    ],
    [
      "TooManyAttemptsError",
      "locked",
      "Too many wrong passwords. Wait a few minutes and try again.",
    ],
  ])("%s is refused as %s", async (name, code, message) => {
    const u = user(async () => {
      throw Object.assign(
        new Error("plugin text that must not reach the page"),
        { name },
      );
    });
    const err = await account
      .changePassword({ user: u, currentPassword: "x", newPassword: "y" })
      .catch((e) => e);
    expect(err).toMatchObject({ code, message, statusCode: 409 });
  });
  test("anything else is a real error, not 'wrong password'", async () => {
    const u = user(async () => {
      throw new Error("database is down");
    });
    await expect(
      account.changePassword({
        user: u,
        currentPassword: "x",
        newPassword: "y",
      }),
    ).rejects.toThrow("database is down");
  });
});
