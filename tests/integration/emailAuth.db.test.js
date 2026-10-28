// P02-T05 against a real MongoDB and the real app: confirming an address,
// resetting a password, and the "confirm first" gate. Needs a MongoDB; skipped
// with SKIP_DB_TESTS=1. Mail goes to the in-memory transport; nothing is sent.
const assert = require("node:assert/strict");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { testConfig } = require("../helpers/config");
const { createUser, createListing } = require("../helpers/factories");
const { createMemoryEmailService } = require("../../src/services/email");
const User = require("../../src/models/user");
const EmailToken = require("../../src/models/emailToken");

const LINK = /\/(?:verify-email|reset-password)\/([A-Za-z0-9_-]{43})/;
const NEW_PASSWORD = "A-better-passphrase-9";
const form = (agent, url, body) => agent.post(url).type("form").send(body);

function appAgent({ required = true } = {}) {
  const emailService = createMemoryEmailService();
  const config = testConfig({
    email: { transport: "console", from: "Dimora <no-reply@localhost>", resendApiKey: null, verificationRequired: required },
  });
  return { agent: createAgent({ config, emailService }), mail: emailService.outbox };
}
const tokenIn = (message) => LINK.exec(message.text)[1];

async function signUp(agent, over = {}) {
  const data = { username: "annie", email: "annie@example.com", password: "correct-horse-battery-42", ...over };
  await form(agent, "/signup", data);
  return data;
}

describeDb("email confirmation and password reset (database)", () => {
  useTestDb();

  describe("confirming the address", () => {
    test("signup sends one link; the page does not use it, the button does, and it works once", async () => {
      const { agent, mail } = appAgent();
      await signUp(agent);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, "annie@example.com");
      const token = tokenIn(mail[0]);

      const page = await agent.get(`/verify-email/${token}`);
      assert.equal(page.status, 200);
      assert.equal((await User.findOne({ username: "annie" })).emailVerifiedAt, null, "opening the link must not confirm");

      const done = await form(agent, "/verify-email", { token });
      assert.equal(done.status, 302);
      assert.ok((await User.findOne({ username: "annie" })).emailVerifiedAt instanceof Date);

      const again = await form(agent, "/verify-email", { token });
      assert.equal(again.status, 400);
      assert.equal((await agent.get(`/verify-email/${token}`)).status, 400);
    });

    test("only a hash of the token is stored", async () => {
      const { agent, mail } = appAgent();
      await signUp(agent);
      const token = tokenIn(mail[0]);
      const rows = await EmailToken.find().lean();
      assert.equal(rows.length, 1);
      assert.equal(JSON.stringify(rows).includes(token), false);
      assert.match(rows[0].tokenHash, /^[0-9a-f]{64}$/);
    });

    test("an expired link, a made-up link and a link for a changed address all fail", async () => {
      const { agent, mail } = appAgent();
      await signUp(agent);
      const token = tokenIn(mail[0]);

      assert.equal((await form(agent, "/verify-email", { token: "x".repeat(43) })).status, 400);
      assert.equal((await form(agent, "/verify-email", { token: "short" })).status, 400);
      assert.equal((await form(agent, "/verify-email", {})).status, 400);

      await User.updateOne({ username: "annie" }, { $set: { email: "other@example.com" } });
      assert.equal((await form(agent, "/verify-email", { token })).status, 400);
      assert.equal((await User.findOne({ username: "annie" })).emailVerifiedAt, null);

      await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000), usedAt: null } });
      assert.equal((await form(agent, "/verify-email", { token })).status, 400);
    });

    test("asking again is throttled, and a new link replaces the old one", async () => {
      const { agent, mail } = appAgent();
      await signUp(agent);
      const first = tokenIn(mail[0]);

      await form(agent, "/verify-email/resend", {});
      assert.equal(mail.length, 1, "a second link within a minute is refused");

      await EmailToken.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
      await form(agent, "/verify-email/resend", {});
      assert.equal(mail.length, 2);
      assert.equal((await form(agent, "/verify-email", { token: first })).status, 400, "the old link stops working");
      assert.equal((await form(agent, "/verify-email", { token: tokenIn(mail[1]) })).status, 302);
    });

    test("a mail failure does not fail the signup", async () => {
      const failing = { transport: "memory", send: async () => { throw new Error("boom"); } };
      const config = testConfig({ email: { transport: "console", verificationRequired: true } });
      const agent = createAgent({ config, emailService: failing });
      const res = await form(agent, "/signup", { username: "bob", email: "bob@example.com", password: "correct-horse-battery-42" });
      assert.equal(res.status, 302);
      assert.ok(await User.findOne({ username: "bob" }));
    });
  });

  describe("the gate", () => {
    test("an unconfirmed member cannot publish or open checkout; a confirmed one gets past the gate", async () => {
      const { agent } = appAgent();
      const { user, password } = await createUser();
      const listing = await createListing({ owner: user, status: "draft" });
      await login(agent, { username: user.username, password });

      const publish = await form(agent, `/host/listings/${listing._id}/publish`, {});
      assert.equal(publish.status, 302);
      assert.equal(publish.headers.location, "/verify-email/needed");
      const checkout = await agent.get(`/listings/${listing._id}/checkout?in=2030-01-01&out=2030-01-03&guests=1`);
      assert.equal(checkout.headers.location, "/verify-email/needed");
      const post = await form(agent, `/listings/${listing._id}/checkout`, {});
      assert.equal(post.headers.location, "/verify-email/needed");

      await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
      // Deserialising reads the user again on the next request.
      const after = await form(agent, `/host/listings/${listing._id}/publish`, {});
      assert.notEqual(after.headers.location, "/verify-email/needed");
    });

    test("with verification switched off nobody is stopped", async () => {
      const { agent } = appAgent({ required: false });
      const { user, password } = await createUser();
      const listing = await createListing({ owner: user, status: "draft" });
      await login(agent, { username: user.username, password });
      const res = await form(agent, `/host/listings/${listing._id}/publish`, {});
      assert.notEqual(res.headers.location, "/verify-email/needed");
    });

    test("the 'needed' page needs a login", async () => {
      const { agent } = appAgent();
      const res = await agent.get("/verify-email/needed");
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login");
    });
  });

  describe("forgot and reset password", () => {
    test("the answer is the same for a known and an unknown address, and only a known one gets mail", async () => {
      const { agent, mail } = appAgent();
      const { user } = await createUser({ email: "known@example.com" });
      const known = await form(agent, "/forgot-password", { email: "KNOWN@example.com" });
      const unknown = await form(agent, "/forgot-password", { email: "nobody@example.com" });
      assert.equal(known.status, 302);
      assert.equal(unknown.status, 302);
      assert.equal(known.headers.location, unknown.headers.location);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, user.email);
    });

    test("suspended and deleted accounts get no mail", async () => {
      const { agent, mail } = appAgent();
      const a = (await createUser({ email: "s@example.com" })).user;
      const b = (await createUser({ email: "d@example.com" })).user;
      await User.updateOne({ _id: a._id }, { $set: { status: "suspended" } });
      await User.updateOne({ _id: b._id }, { $set: { status: "deleted" } });
      await form(agent, "/forgot-password", { email: "s@example.com" });
      await form(agent, "/forgot-password", { email: "d@example.com" });
      assert.equal(mail.length, 0);
    });

    test("a mail failure gives the same answer as success", async () => {
      const failing = { transport: "memory", send: async () => { throw new Error("provider down"); } };
      const agent = createAgent({ config: testConfig(), emailService: failing });
      await createUser({ email: "known@example.com" });
      const res = await form(agent, "/forgot-password", { email: "known@example.com" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login");
    });

    test("the link sets a new password once; the old one stops working; the lock is lifted", async () => {
      const { agent, mail } = appAgent();
      const { user, password } = await createUser({ email: "known@example.com" });
      await User.updateOne({ _id: user._id }, { $set: { attempts: 9 } });
      await form(agent, "/forgot-password", { email: "known@example.com" });
      const token = tokenIn(mail[0]);

      assert.equal((await agent.get(`/reset-password/${token}`)).status, 200);
      const done = await form(agent, "/reset-password", { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
      assert.equal(done.status, 302);
      assert.equal(done.headers.location, "/login");

      const fresh = createAgent({ config: testConfig() });
      await login(fresh, { username: user.username, password: NEW_PASSWORD });
      await assert.rejects(() => login(createAgent({ config: testConfig() }), { username: user.username, password }));
      const stored = await User.findById(user._id);
      assert.equal(stored.attempts, 0);
      assert.ok(stored.emailVerifiedAt instanceof Date, "the link proved the address");

      assert.equal((await form(agent, "/reset-password", { token, newPassword: NEW_PASSWORD + "x", confirmPassword: NEW_PASSWORD + "x" })).status, 400);
      assert.equal(mail.length, 2, "and a 'password changed' note was sent");
      assert.match(mail[1].subject, /changed/);
    });

    test("a password that breaks the rules keeps the link alive", async () => {
      const { agent, mail } = appAgent();
      await createUser({ email: "known@example.com" });
      await form(agent, "/forgot-password", { email: "known@example.com" });
      const token = tokenIn(mail[0]);
      const weak = await form(agent, "/reset-password", { token, newPassword: "short", confirmPassword: "short" });
      assert.equal(weak.status, 302);
      assert.equal(weak.headers.location, `/reset-password/${token}`);
      const mismatch = await form(agent, "/reset-password", { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD + "!" });
      assert.equal(mismatch.headers.location, `/reset-password/${token}`);
      const ok = await form(agent, "/reset-password", { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
      assert.equal(ok.headers.location, "/login");
    });

    test("a new request replaces the old link; an expired or invented link fails", async () => {
      const { agent, mail } = appAgent();
      const { user } = await createUser({ email: "known@example.com" });
      await form(agent, "/forgot-password", { email: "known@example.com" });
      const first = tokenIn(mail[0]);
      await EmailToken.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
      await form(agent, "/forgot-password", { email: "known@example.com" });
      assert.equal(mail.length, 2);
      assert.equal((await agent.get(`/reset-password/${first}`)).status, 400);

      const second = tokenIn(mail[1]);
      await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000), usedAt: null } });
      assert.equal((await agent.get(`/reset-password/${second}`)).status, 400);
      assert.equal((await agent.get(`/reset-password/${"y".repeat(43)}`)).status, 400);
      assert.equal((await agent.get("/reset-password/not-a-token")).status, 400);
      assert.equal(user.status, "active");
    });

    test("only one of two simultaneous uses of a link wins", async () => {
      const { agent, mail } = appAgent();
      await createUser({ email: "known@example.com" });
      await form(agent, "/forgot-password", { email: "known@example.com" });
      const token = tokenIn(mail[0]);
      const service = require("../../src/services/emailAuth");
      const results = await Promise.all([
        service.resetPassword({ raw: token, newPassword: NEW_PASSWORD }),
        service.resetPassword({ raw: token, newPassword: NEW_PASSWORD + "2" }),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1);
    });

    test("five emails an hour per account, one a minute", async () => {
      const { agent, mail } = appAgent();
      await createUser({ email: "known@example.com" });
      for (let i = 0; i < 7; i++) {
        // Each request is two minutes after the one before (the per-minute gap is not what is tested here).
        await EmailToken.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
        await form(agent, "/forgot-password", { email: "known@example.com" });
      }
      assert.equal(mail.length, 5, `sent ${mail.length}`);
    });
  });
});
