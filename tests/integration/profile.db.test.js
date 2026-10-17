// P02-T03 through the real routes: the public profile and the owner's edit
// form, with Cloudinary mocked. Needs a MongoDB (see tests/helpers/db.js);
// skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing, createReview } = require("../helpers/factories");
const { uploader, resetExternalMocks } = require("../helpers/mocks");
const User = require("../../src/models/user");

const pad = (head, total = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(total - head.length)]);
const PNG = (total = 64) => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], total);
const JPEG = () => pad([0xff, 0xd8, 0xff, 0xe0]);

const EMAIL = "private.person@example.com";

async function member(overrides = {}) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

const reload = (user) => User.findById(user._id);
const put = (agent, fields = {}) => {
  let req = agent.put("/account/profile");
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req;
};

afterEach(resetExternalMocks);

describeDb("profile pages", () => {
  useTestDb();

  describe("the public page /users/:id", () => {
    test("shows name, photo, bio, member since, counts, and is public", async () => {
      const { user } = await createUser({ email: EMAIL });
      await User.updateOne(
        { _id: user._id },
        {
          displayName: "Asha K",
          bio: "I love old houses.",
          avatar: { url: "https://res.cloudinary.test/dimora_DEV/me.jpg", filename: "dimora_DEV/me" },
        },
      );
      await createListing({ owner: user._id, title: "Mine" });
      const res = await createAgent().get(`/users/${user._id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Asha K");
      expect(res.text).toContain(`@${user.username}`);
      expect(res.text).toContain("I love old houses.");
      expect(res.text).toMatch(/Member since [A-Z][a-z]+ \d{4}/);
      expect(res.text).toMatch(/<dt>Listings<\/dt><dd>1<\/dd>/);
      expect(res.text).toMatch(/<dt>Reviews written<\/dt><dd>0<\/dd>/);
      expect(res.text).toContain("https://res.cloudinary.test/dimora_DEV/me.jpg");
    });

    test("the email address, password hash and salt never appear, even for the owner", async () => {
      const { agent, user } = await member({ email: EMAIL });
      const stored = await User.findById(user._id).select("+hash +salt");
      for (const viewer of [createAgent(), agent]) {
        const { text } = await viewer.get(`/users/${user._id}`);
        expect(text.toLowerCase()).not.toContain(EMAIL);
        expect(text).not.toContain(stored.hash);
        expect(text).not.toContain(stored.salt);
      }
    });

    test("only listings a visitor can open are counted", async () => {
      const { user } = await createUser();
      await createListing({ owner: user._id });
      await createListing({ owner: user._id, status: "draft" });
      await createListing({ owner: user._id, status: "unpublished" });
      await createListing({ owner: user._id, deletedAt: new Date() });
      const { text } = await createAgent().get(`/users/${user._id}`);
      expect(text).toMatch(/<dt>Listings<\/dt><dd>1<\/dd>/);
    });

    test("reviews written are counted, and recent ones link to public listings only", async () => {
      const { user: author } = await createUser();
      const { user: host } = await createUser();
      const open = await createListing({ owner: host._id, title: "Open flat" });
      const hidden = await createListing({ owner: host._id, title: "Hidden flat", status: "unpublished" });
      await createReview({ listing: open, author, rating: 4, comment: "Really nice place." });
      await createReview({ listing: hidden, author, rating: 2, comment: "Secret review text." });
      const { text } = await createAgent().get(`/users/${author._id}`);
      expect(text).toMatch(/<dt>Reviews written<\/dt><dd>2<\/dd>/);
      expect(text).toContain("Open flat");
      expect(text).toContain(`/listings/${open._id}`);
      expect(text).toContain("Really nice place.");
      expect(text).not.toContain("Hidden flat");
      expect(text).not.toContain("Secret review text.");
    });

    test("name, bio and review text are escaped", async () => {
      const { user } = await createUser();
      await User.updateOne(
        { _id: user._id },
        { displayName: "<script>alert(1)</script>", bio: "<img src=x onerror=alert(1)>" },
      );
      const { text } = await createAgent().get(`/users/${user._id}`);
      expect(text).not.toContain("<script>alert(1)");
      expect(text).not.toContain("<img src=x");
      expect(text).toContain("&lt;script&gt;alert(1)");
      expect(text).not.toMatch(/style="/);
    });

    test("an unknown, malformed, suspended or deleted account is a plain 404", async () => {
      const { user: suspended } = await createUser();
      const { user: gone } = await createUser();
      await User.updateOne({ _id: suspended._id }, { status: "suspended" });
      await User.updateOne({ _id: gone._id }, { status: "deleted" });
      const agent = createAgent();
      for (const id of ["64b0000000000000000000ff", "nope", "123", suspended._id, gone._id]) {
        expect((await agent.get(`/users/${id}`)).status).toBe(404);
      }
    });

    test("the owner sees an edit link on their own page, others do not", async () => {
      const { agent, user } = await member();
      expect((await agent.get(`/users/${user._id}`)).text).toContain("Edit your profile");
      expect((await createAgent().get(`/users/${user._id}`)).text).not.toContain("Edit your profile");
    });

    test("a member without a photo gets a letter, not a broken image", async () => {
      const { user } = await createUser({ username: "zed_user" });
      const { text } = await createAgent().get(`/users/${user._id}`);
      expect(text).toContain("avatar-initial");
      expect(text).not.toMatch(/<img class="avatar/);
    });
  });

  describe("the edit form /account/profile", () => {
    test("anonymous visitors are sent to /login for both the form and the save", async () => {
      const agent = createAgent();
      const form = await agent.get("/account/profile");
      expect(form.status).toBe(302);
      expect(form.headers.location).toBe("/login");
      expect((await put(agent, { displayName: "Hacker" })).status).toBe(302);
    });

    test("the form is filled with the member's own values and has no email field", async () => {
      const { agent, user } = await member({ email: EMAIL });
      await User.updateOne({ _id: user._id }, { displayName: "Asha K", bio: "About me" });
      const res = await agent.get("/account/profile");
      expect(res.status).toBe(200);
      expect(res.text).toContain('value="Asha K"');
      expect(res.text).toContain("About me");
      expect(res.text).toContain('name="avatar"');
      expect(res.text).not.toMatch(/type="email"/);
      expect(res.text.toLowerCase()).not.toContain(EMAIL);
    });

    test("saving changes the display name and bio and goes back to the form", async () => {
      const { agent, user } = await member();
      const res = await put(agent, { displayName: "  New Name  ", bio: "New bio" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/account/profile");
      const stored = await reload(user);
      expect(stored.displayName).toBe("New Name");
      expect(stored.bio).toBe("New bio");
      const page = await agent.get("/account/profile");
      expect(page.text).toContain("Your profile has been updated.");
    });

    test("an empty display name falls back to the username", async () => {
      const { agent, user } = await member();
      await put(agent, { displayName: "", bio: "" });
      expect((await reload(user)).displayName).toBe(user.username);
    });

    test("only the signed-in member is changed: another member's profile is untouched", async () => {
      const { agent } = await member();
      const { user: other } = await createUser();
      await User.updateOne({ _id: other._id }, { displayName: "Other Person" });
      await put(agent, { displayName: "Mine", id: String(other._id), userId: String(other._id) });
      expect((await reload(other)).displayName).toBe("Other Person");
    });

    test("fields that are not part of the form cannot change the email, role or status", async () => {
      const { agent, user } = await member({ email: EMAIL });
      const res = await put(agent, { displayName: "Mine", email: "attacker@example.com", role: "admin", status: "suspended" });
      expect(res.status).toBe(400);
      const stored = await reload(user);
      expect(stored.email).toBe(EMAIL);
      expect(stored.role).toBe("member");
      expect(stored.status).toBe("active");
      expect(stored.displayName).toBe(user.username);
    });

    test("a too long name or bio is refused with a message and the typed values", async () => {
      const { agent, user } = await member();
      const res = await put(agent, { displayName: "x".repeat(61), bio: "y".repeat(501) });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Display name must be 60 characters or fewer/);
      expect(res.text).toMatch(/Bio must be 500 characters or fewer/);
      expect((await reload(user)).bio).toBe("");
    });
  });

  describe("the profile photo", () => {
    test("a real PNG is uploaded and stored, and shown on the public page", async () => {
      const { agent, user } = await member();
      const res = await put(agent, { displayName: "Me" }).attach("avatar", PNG(), {
        filename: "me.png",
        contentType: "image/png",
      });
      expect(res.status).toBe(302);
      expect(uploader.upload_stream).toHaveBeenCalledTimes(1);
      const stored = await reload(user);
      expect(stored.avatar.url).toMatch(/^https:\/\/res\.cloudinary\./);
      expect(stored.avatar.filename).toMatch(/^dimora_/);
      const page = await createAgent().get(`/users/${user._id}`);
      expect(page.text).toContain(stored.avatar.url);
    });

    test("replacing the photo deletes the old one after saving", async () => {
      const { agent, user } = await member();
      await User.updateOne(
        { _id: user._id },
        { avatar: { url: "https://res.cloudinary.test/dimora_DEV/old.jpg", filename: "dimora_DEV/old" } },
      );
      await put(agent, { displayName: "Me" }).attach("avatar", JPEG(), {
        filename: "new.jpg",
        contentType: "image/jpeg",
      });
      expect(uploader.destroy).toHaveBeenCalledWith("dimora_DEV/old");
      expect((await reload(user)).avatar.filename).not.toBe("dimora_DEV/old");
    });

    test("a fake image (text called .jpg, or a wrong type) is refused: nothing uploaded, nothing changed", async () => {
      const { agent, user } = await member();
      const fake = await put(agent, { displayName: "Changed" }).attach("avatar", Buffer.from("just text"), {
        filename: "me.jpg",
        contentType: "image/jpeg",
      });
      expect(fake.status).toBe(400);
      expect(fake.text).toMatch(/not a PNG, JPEG or WebP image/);
      const gif = await put(agent, { displayName: "Changed" }).attach("avatar", Buffer.from("GIF89a....."), {
        filename: "me.gif",
        contentType: "image/gif",
      });
      expect(gif.status).toBe(400);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
      const stored = await reload(user);
      expect(stored.displayName).toBe(user.username);
      expect(stored.avatar && stored.avatar.url).toBeFalsy();
    });

    test("2 MB is the most allowed: a larger image is refused before anything is uploaded", async () => {
      const { agent, user } = await member();
      const big = await put(agent, {}).attach("avatar", PNG(2 * 1024 * 1024 + 1), {
        filename: "big.png",
        contentType: "image/png",
      });
      expect(big.status).toBe(400);
      expect(big.text).toMatch(/too large \(maximum 2 MB\)/);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
      const ok = await put(agent, {}).attach("avatar", PNG(2 * 1024 * 1024), {
        filename: "ok.png",
        contentType: "image/png",
      });
      expect(ok.status).toBe(302);
      expect((await reload(user)).avatar.url).toBeTruthy();
    });

    test("an image over the 5 MB request limit is refused too", async () => {
      const { agent } = await member();
      const res = await put(agent, {}).attach("avatar", PNG(5 * 1024 * 1024 + 10), {
        filename: "huge.png",
        contentType: "image/png",
      });
      expect(res.status).toBe(413);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("remove my photo clears it and deletes the file; without a photo the box is not offered", async () => {
      const { agent, user } = await member();
      expect((await agent.get("/account/profile")).text).not.toContain('name="removeAvatar"');
      await User.updateOne(
        { _id: user._id },
        { avatar: { url: "https://res.cloudinary.test/dimora_DEV/me.jpg", filename: "dimora_DEV/me" } },
      );
      expect((await agent.get("/account/profile")).text).toContain('name="removeAvatar"');
      await put(agent, { displayName: "Me", removeAvatar: "on" });
      expect(uploader.destroy).toHaveBeenCalledWith("dimora_DEV/me");
      expect((await reload(user)).avatar.url).toBeFalsy();
    });

    test("saving only text keeps the photo and deletes nothing", async () => {
      const { agent, user } = await member();
      await User.updateOne(
        { _id: user._id },
        { avatar: { url: "https://res.cloudinary.test/dimora_DEV/me.jpg", filename: "dimora_DEV/me" } },
      );
      await put(agent, { displayName: "Me", bio: "Hello" });
      expect(uploader.destroy).not.toHaveBeenCalled();
      expect((await reload(user)).avatar.filename).toBe("dimora_DEV/me");
    });
  });
});
