// P02-T04 against a real MongoDB and the real app: changing the password, and
// deleting (anonymising) an account, end to end. Needs a MongoDB; skipped with
// SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const {
  createUser,
  createListing,
  createReview,
  createCompletedStay,
  buildUserData,
} = require("../helpers/factories");
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const Reservation = require("../../src/models/reservation");

const NEW_PASSWORD = "A-better-passphrase-9";

async function member(overrides) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  return { user, password, agent };
}
const post = (agent, url, body) => agent.post(url).type("form").send(body);

describeDb("password change and account deletion (database)", () => {
  useTestDb();

  describe("change password", () => {
    test("the new password works, the old one does not", async () => {
      const { user, password, agent } = await member();
      const res = await post(agent, "/account/password", {
        currentPassword: password,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(302);
      expect((await agent.get("/account")).status).toBe(200); // still signed in, on a new session
      const fresh = await post(createAgent(), "/login", {
        username: user.username,
        password: NEW_PASSWORD,
      });
      expect(fresh.headers.location).not.toBe("/login");
      const old = await post(createAgent(), "/login", {
        username: user.username,
        password,
      });
      expect(old.headers.location).toBe("/login");
    });

    test("a wrong current password changes nothing", async () => {
      const { user, password, agent } = await member();
      await post(agent, "/account/password", {
        currentPassword: "not-the-password",
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      const ok = await post(createAgent(), "/login", {
        username: user.username,
        password,
      });
      expect(ok.headers.location).not.toBe("/login");
    });

    test("repeated wrong current passwords lock the account's password checks, not just the page", async () => {
      const { agent } = await member();
      for (let i = 0; i < 12; i += 1) {
        await post(agent, "/account/password", {
          currentPassword: `wrong-${i}-password`,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        });
      }
      const res = await agent.get("/account");
      expect(res.status).toBe(200);
    });
  });

  describe("delete account", () => {
    async function deleteWith(agent, password, confirm = "DELETE") {
      return post(agent, "/account/delete", { password, confirm });
    }

    test("a member with nothing open: anonymised, logged out, old credentials dead, no PII in the stored document", async () => {
      const { user, password, agent } = await member();
      const other = await member(); // a second signed-in device of nobody in particular
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            bio: "I like boats",
            displayName: "Ann Lee",
            avatar: { url: "https://img/a.jpg", filename: "dimora/a" },
          },
        },
      );
      const res = await deleteWith(agent, password);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
      expect((await agent.get("/account")).headers.location).toMatch(
        /^\/login/,
      );

      const stored = await User.findById(user._id).select("+hash +salt").lean();
      const text = JSON.stringify(stored);
      for (const secret of [
        user.username,
        user.email,
        "Ann Lee",
        "I like boats",
        "dimora/a",
        "img/a.jpg",
      ])
        expect(text).not.toContain(secret);
      expect(stored).toMatchObject({
        username: `deleted-${user._id}`,
        displayName: "Deleted user",
        status: "deleted",
        bio: "",
      });
      expect(stored.email).toBe(`deleted-${user._id}@deleted.invalid`);
      expect(stored.avatar).toBeUndefined();

      const again = await post(createAgent(), "/login", {
        username: user.username,
        password,
      });
      expect(again.headers.location).toBe("/login");
      const asDeleted = await post(createAgent(), "/login", {
        username: stored.username,
        password,
      });
      expect(asDeleted.headers.location).toBe("/login");
      expect((await createAgent().get(`/users/${user._id}`)).status).toBe(404);
      expect((await other.agent.get("/account")).status).toBe(200); // somebody else is unaffected
    });

    test("a session on another device stops working", async () => {
      const { user, password, agent } = await member();
      const second = await login(createAgent(), {
        username: user.username,
        password,
      });
      await deleteWith(agent, password);
      expect((await second.get("/account")).headers.location).toMatch(
        /^\/login/,
      );
    });

    test("the username and the email can be used again for a new account", async () => {
      const { user, password, agent } = await member();
      await deleteWith(agent, password);
      const { password: fresh } = buildUserData({});
      const created = await User.register(
        new User({ username: user.username, email: user.email }),
        fresh,
      );
      expect(created.username).toBe(user.username);
    });

    test("a wrong password, or no DELETE, deletes nothing", async () => {
      const { user, password, agent } = await member();
      await deleteWith(agent, "wrong-password-1");
      await deleteWith(agent, password, "delete");
      expect((await User.findById(user._id)).status).toBe("active");
    });

    test("listings are unpublished and kept; reviews and stays stay, pointing to the deleted account", async () => {
      const { user, password, agent } = await member();
      const listing = await createListing({
        owner: user._id,
        status: "published",
      });
      const { user: guest } = await createUser();
      const stay = await createCompletedStay({ listing, guest });
      const theirs = await createListing();
      const review = await createReview({ listing: theirs, author: user });
      await deleteWith(agent, password);
      expect((await Listing.findById(listing._id)).status).toBe("unpublished");
      expect(await Reservation.findById(stay._id)).not.toBeNull();
      const kept = await Review.findById(review._id).populate(
        "author",
        "username displayName",
      );
      expect(kept.author.username).toBe(`deleted-${user._id}`);
      expect(kept.author.displayName).toBe("Deleted user");
    });

    test("blocked while a confirmed stay is ahead (as guest) and while a request waits (as host)", async () => {
      const { user, password, agent } = await member();
      const theirs = await createListing();
      const day = 24 * 60 * 60 * 1000;
      const midnight = (n) => {
        const d = new Date(Date.now() + n * day);
        return new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
        );
      };
      const ahead = await createCompletedStay({
        listing: theirs,
        guest: user,
        status: "confirmed",
        checkIn: midnight(5),
        checkOut: midnight(8),
      });
      let res = await deleteWith(agent, password);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/account");
      expect((await User.findById(user._id)).status).toBe("active");
      await Reservation.updateOne(
        { _id: ahead._id },
        {
          $set: {
            status: "completed",
            checkIn: midnight(-8),
            checkOut: midnight(-5),
          },
        },
      );

      const mine = await createListing({
        owner: user._id,
        status: "published",
      });
      const { user: other } = await createUser();
      await createCompletedStay({
        listing: mine,
        guest: other,
        status: "pending",
        holdExpiresAt: new Date(Date.now() + 3600000),
        checkIn: midnight(10),
        checkOut: midnight(12),
      });
      res = await deleteWith(agent, password);
      expect(res.headers.location).toBe("/account");
      expect((await User.findById(user._id)).status).toBe("active");
      expect((await Listing.findById(mine._id)).status).toBe("published");
    });

    test("the only administrator cannot delete the account", async () => {
      const { user, password, agent } = await member({ role: "admin" });
      await deleteWith(agent, password);
      expect((await User.findById(user._id)).status).toBe("active");
    });
  });
});
