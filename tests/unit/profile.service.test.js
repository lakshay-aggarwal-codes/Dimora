// P02-T03: the public profile data, with fake models (no database).
const { loadPublicProfile, formatMonthYear, excerpt, PUBLIC_FIELDS } = require("../../src/services/profile");

const ID = "64b0000000000000000000a1";
const L1 = "64b0000000000000000000b1";

function chain(result) {
  const c = {
    select(arg) {
      c.selected = arg;
      return c;
    },
    sort() {
      return c;
    },
    limit() {
      return c;
    },
    lean() {
      return Promise.resolve(result);
    },
  };
  return c;
}

function models({ user, listingCount = 0, reviewCount = 0, reviews = [], listings = [] } = {}) {
  const calls = { user: [], listingCount: [], listingFind: [] };
  const userChain = chain(user);
  return {
    calls,
    userChain,
    User: {
      findOne(filter) {
        calls.user.push(filter);
        return userChain;
      },
    },
    Listing: {
      async countDocuments(filter) {
        calls.listingCount.push(filter);
        return listingCount;
      },
      find(filter) {
        calls.listingFind.push(filter);
        return chain(listings);
      },
    },
    Review: {
      async countDocuments() {
        return reviewCount;
      },
      find() {
        return chain(reviews);
      },
    },
  };
}

const USER = {
  _id: ID,
  username: "asha",
  displayName: "Asha K",
  bio: "Hi",
  avatar: { url: "https://res.cloudinary.test/a.jpg" },
  createdAt: new Date("2026-10-17T10:00:00.000Z"),
};

describe("formatMonthYear / excerpt", () => {
  test("month and year in Indian time; junk is empty", () => {
    expect(formatMonthYear(new Date("2026-10-17T10:00:00.000Z"))).toBe("October 2026");
    expect(formatMonthYear(new Date("2026-09-30T20:00:00.000Z"))).toBe("October 2026"); // already 1 Oct in India
    for (const bad of [undefined, null, "2026-10-17", new Date("x")]) expect(formatMonthYear(bad)).toBe("");
  });

  test("an excerpt collapses spaces and is cut at 200 characters with an ellipsis", () => {
    expect(excerpt("  a \n  b  ")).toBe("a b");
    expect(excerpt(undefined)).toBe("");
    const long = excerpt("x".repeat(300));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(excerpt("x".repeat(200))).toHaveLength(200);
  });
});

describe("loadPublicProfile", () => {
  test("a malformed id, a non-string and an unknown or inactive user all give null", async () => {
    const m = models({ user: null });
    for (const id of ["nope", "123", undefined, null, 5, "../etc"]) {
      expect(await loadPublicProfile(m, id)).toBeNull();
    }
    expect(await loadPublicProfile(m, ID)).toBeNull();
  });

  test("only active users are looked up, with a field list that leaves out the email and secrets", async () => {
    const m = models({ user: USER });
    await loadPublicProfile(m, ID);
    expect(m.calls.user[0]).toEqual({ _id: ID, status: "active" });
    expect(m.userChain.selected).toBe(PUBLIC_FIELDS);
    for (const secret of ["email", "hash", "salt", "role", "status"]) {
      expect(PUBLIC_FIELDS.split(" ")).not.toContain(secret);
    }
  });

  test("the result has display name, username, avatar, bio, member since and counts; nothing else", async () => {
    const m = models({ user: USER, listingCount: 3, reviewCount: 7 });
    const profile = await loadPublicProfile(m, ID);
    expect(profile).toEqual({
      id: ID,
      displayName: "Asha K",
      username: "asha",
      avatarUrl: "https://res.cloudinary.test/a.jpg",
      bio: "Hi",
      memberSince: "October 2026",
      listingCount: 3,
      reviewCount: 7,
      hostCancellationCount: 0,
      reviews: [],
    });
  });

  test("the host cancellation counter is passed on (and is 0 when missing or not a whole number)", async () => {
    const withCount = await loadPublicProfile(models({ user: { ...USER, hostCancellationCount: 2 } }), ID);
    expect(withCount.hostCancellationCount).toBe(2);
    for (const bad of [undefined, null, "3", -1.5, NaN]) {
      const profile = await loadPublicProfile(models({ user: { ...USER, hostCancellationCount: bad } }), ID);
      expect(profile.hostCancellationCount).toBe(0);
    }
  });

  test("the listing count asks for published, not deleted listings of this user", async () => {
    const m = models({ user: USER });
    await loadPublicProfile(m, ID);
    expect(m.calls.listingCount[0]).toMatchObject({ owner: ID, status: "published", deletedAt: null });
  });

  test("a user without display name, avatar or bio still has a usable profile", async () => {
    const profile = await loadPublicProfile(models({ user: { _id: ID, username: "bob" } }), ID);
    expect(profile.displayName).toBe("bob");
    expect(profile.avatarUrl).toBeNull();
    expect(profile.bio).toBe("");
    expect(profile.memberSince).toBe("");
  });

  test("recent reviews appear only with a listing a visitor could open, newest first, at most 5", async () => {
    const reviews = Array.from({ length: 8 }, (_, i) => ({
      _id: `r${i}`,
      rating: 4,
      comment: `comment ${i}`,
    }));
    // r0 is on a public listing; r1..r6 too; r7 is on a hidden one (not returned by the query).
    const listings = [
      { _id: L1, title: "Sunny flat", reviews: ["r0", "r1", "r2", "r3", "r4", "r5", "r6"] },
    ];
    const m = models({ user: USER, reviews, listings, reviewCount: 8 });
    const profile = await loadPublicProfile(m, ID);
    expect(profile.reviewCount).toBe(8);
    expect(profile.reviews.map((r) => r.excerpt)).toEqual([
      "comment 0",
      "comment 1",
      "comment 2",
      "comment 3",
      "comment 4",
    ]);
    expect(profile.reviews[0]).toEqual({
      rating: 4,
      excerpt: "comment 0",
      listingId: L1,
      listingTitle: "Sunny flat",
    });
    expect(m.calls.listingFind[0]).toMatchObject({ status: "published", deletedAt: null });
  });
});
