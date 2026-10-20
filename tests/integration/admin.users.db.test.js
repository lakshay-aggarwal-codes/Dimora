// P14-T02 against a real MongoDB: suspend / reinstate through the real routes,
// with real sessions, listings and the audit log. Skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const AuditLog = require("../../src/models/auditLog");
const { promoteToAdmin } = require("../../src/services/adminBootstrap");

async function agentFor(overrides) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user, password };
}
async function adminAgent() {
  const made = await agentFor();
  await promoteToAdmin(made.user.email);
  return made;
}
const rows = (action) => AuditLog.find({ action }).lean();

describeDb("admin user management (database)", () => {
  useTestDb();

  test("a member gets 404 on the user pages and cannot suspend anyone", async () => {
    const { agent } = await agentFor();
    const { user: victim } = await createUser();
    expect((await agent.get("/admin/users")).status).toBe(404);
    expect((await agent.get(`/admin/users/${victim._id}`)).status).toBe(404);
    expect((await agent.post(`/admin/users/${victim._id}/suspend`).type("form").send({ reason: "because" })).status).toBe(404);
    expect((await User.findById(victim._id)).status).toBe("active");
    expect(await AuditLog.countDocuments({ action: "user.suspend" })).toBe(0);
  });

  test("search finds by username, email and display name, case-insensitively, as plain text", async () => {
    const { agent } = await adminAgent();
    await createUser({ username: "marigold", email: "mari@example.com" });
    const { user: other } = await createUser({ username: "other", email: "someone@example.com" });
    await User.updateOne({ _id: other._id }, { displayName: "Marian K" });
    const byName = await agent.get("/admin/users?q=MARI");
    expect(byName.text).toMatch(/marigold/);
    expect(byName.text).toMatch(/other/); // display name "Marian K"
    const none = await agent.get("/admin/users?q=.*");
    expect(none.text).toMatch(/No accounts match/);
    const suspendedOnly = await agent.get("/admin/users?status=suspended");
    expect(suspendedOnly.text).toMatch(/No accounts match/);
  });

  test("suspend: status, listings hidden, sessions gone, login refused, one audit row", async () => {
    const boss = await adminAgent();
    const host = await agentFor();
    const live = await createListing({ owner: host.user, status: "published" });
    const draft = await createListing({ owner: host.user, status: "draft" });
    const moderated = await createListing({ owner: host.user, status: "suspended" });
    const elsewhere = await createListing({ status: "published" });
    expect((await host.agent.get("/listings/new")).status).toBe(200);

    const res = await boss.agent.post(`/admin/users/${host.user._id}/suspend`).type("form").send({ reason: "  repeated fake listings  " });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/users/${host.user._id}`);

    expect((await User.findById(host.user._id)).status).toBe("suspended");
    expect((await Listing.findById(live._id)).status).toBe("suspended");
    expect((await Listing.findById(live._id)).hiddenByOwnerSuspension).toBe(true);
    expect((await Listing.findById(draft._id)).status).toBe("draft");
    const m = await Listing.findById(moderated._id);
    expect(m.status).toBe("suspended");
    expect(m.hiddenByOwnerSuspension).toBeUndefined();
    expect((await Listing.findById(elsewhere._id)).status).toBe("published");

    // The open session of the suspended person is gone: they are sent to log in.
    const after = await host.agent.get("/listings/new");
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe("/login");
    // The admin's own session is untouched.
    expect((await boss.agent.get("/admin/users")).status).toBe(200);
    // And a new login is refused.
    const again = createAgent();
    await login(again, { username: host.user.username, password: host.password });
    expect((await again.get("/listings/new")).status).toBe(302);

    const logged = await rows("user.suspend");
    expect(logged).toHaveLength(1);
    expect(logged[0].reason).toBe("repeated fake listings");
    expect(logged[0].actor.equals(boss.user._id)).toBe(true);
    expect(logged[0].targetId.equals(host.user._id)).toBe(true);
    expect(logged[0].details).toMatchObject({ listingsHidden: 1, from: "active", to: "suspended" });
    expect(logged[0].details.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(logged[0])).not.toMatch(/example\.com/);
  });

  test("the suspended host's listing is not shown publicly", async () => {
    const boss = await adminAgent();
    const host = await createUser();
    const live = await createListing({ owner: host.user, status: "published" });
    expect((await createAgent().get(`/listings/${live._id}`)).status).toBe(200);
    await boss.agent.post(`/admin/users/${host.user._id}/suspend`).type("form").send({ reason: "fraud reports" });
    expect((await createAgent().get(`/listings/${live._id}`)).status).not.toBe(200);
    expect((await createAgent().get(`/users/${host.user._id}`)).status).toBe(404);
  });

  test("reinstate: active again, only the hidden listings come back, one audit row", async () => {
    const boss = await adminAgent();
    const host = await createUser();
    const live = await createListing({ owner: host.user, status: "published" });
    const moderated = await createListing({ owner: host.user, status: "suspended" });
    await boss.agent.post(`/admin/users/${host.user._id}/suspend`).type("form").send({ reason: "fraud reports" });

    const res = await boss.agent.post(`/admin/users/${host.user._id}/reinstate`).type("form").send({ reason: "appeal accepted" });
    expect(res.status).toBe(302);

    expect((await User.findById(host.user._id)).status).toBe("active");
    const back = await Listing.findById(live._id);
    expect(back.status).toBe("published");
    expect(back.hiddenByOwnerSuspension).toBeUndefined();
    expect((await Listing.findById(moderated._id)).status).toBe("suspended");

    const logged = await rows("user.reinstate");
    expect(logged).toHaveLength(1);
    expect(logged[0].reason).toBe("appeal accepted");
    expect(logged[0].details).toMatchObject({ listingsRestored: 1 });

    const again = createAgent();
    await login(again, { username: host.user.username, password: host.password });
    expect((await again.get("/listings/new")).status).toBe(200);
  });

  describe("refusals change nothing and write no audit row", () => {
    test("no reason, or a too-short one", async () => {
      const boss = await adminAgent();
      const { user } = await createUser();
      for (const reason of [undefined, "", "   ", "abcd"]) {
        const res = await boss.agent.post(`/admin/users/${user._id}/suspend`).type("form").send(reason === undefined ? {} : { reason });
        expect(res.status).toBe(302);
      }
      expect((await User.findById(user._id)).status).toBe("active");
      expect(await AuditLog.countDocuments({ action: "user.suspend" })).toBe(0);
    });

    test("an admin cannot suspend themselves", async () => {
      const boss = await adminAgent();
      await boss.agent.post(`/admin/users/${boss.user._id}/suspend`).type("form").send({ reason: "testing it out" });
      expect((await User.findById(boss.user._id)).status).toBe("active");
      expect(await AuditLog.countDocuments({ action: "user.suspend" })).toBe(0);
      expect((await boss.agent.get("/admin/users")).status).toBe(200);
    });

    test("the last admin cannot be suspended; another admin can while two exist", async () => {
      const first = await adminAgent();
      const second = await adminAgent();
      // Two admins: the first suspends the second.
      await first.agent.post(`/admin/users/${second.user._id}/suspend`).type("form").send({ reason: "left the team" });
      expect((await User.findById(second.user._id)).status).toBe("suspended");
      // One active admin left (the first): suspending themselves is refused.
      await first.agent.post(`/admin/users/${first.user._id}/suspend`).type("form").send({ reason: "testing it out" });
      expect((await User.findById(first.user._id)).status).toBe("active");
    });

    test("suspending twice, an unknown id and a malformed id", async () => {
      const boss = await adminAgent();
      const { user } = await createUser();
      await boss.agent.post(`/admin/users/${user._id}/suspend`).type("form").send({ reason: "spam listings" });
      await boss.agent.post(`/admin/users/${user._id}/suspend`).type("form").send({ reason: "spam listings" });
      await boss.agent.post("/admin/users/64b64b64b64b64b64b64b64b/suspend").type("form").send({ reason: "spam listings" });
      await boss.agent.post("/admin/users/not-an-id/suspend").type("form").send({ reason: "spam listings" });
      expect(await AuditLog.countDocuments({ action: "user.suspend" })).toBe(1);
      expect((await boss.agent.get("/admin/users/not-an-id")).status).toBe(404);
    });

    test("an active account cannot be reinstated", async () => {
      const boss = await adminAgent();
      const { user } = await createUser();
      await boss.agent.post(`/admin/users/${user._id}/reinstate`).type("form").send({ reason: "appeal accepted" });
      expect(await AuditLog.countDocuments({ action: "user.reinstate" })).toBe(0);
    });
  });

  test("the account page shows the activity summary and the admin history", async () => {
    const boss = await adminAgent();
    const host = await createUser();
    await createListing({ owner: host.user, status: "published" });
    await boss.agent.post(`/admin/users/${host.user._id}/suspend`).type("form").send({ reason: "fraud reports" });
    const page = await boss.agent.get(`/admin/users/${host.user._id}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Listings: 1/);
    expect(page.text).toMatch(/user\.suspend/);
    expect(page.text).toMatch(/fraud reports/);
    expect(page.text).toMatch(/Reinstate account/);
  });
});
