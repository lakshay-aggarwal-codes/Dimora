// P14-T01 against a real MongoDB: the guard with real sessions, the audit
// viewer, append-only storage, make-admin, and "no way to become an admin from
// the site". Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const express = require("express");
const request = require("supertest");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser } = require("../helpers/factories");
const User = require("../../src/models/user");
const AuditLog = require("../../src/models/auditLog");
const audit = require("../../src/services/audit");
const { promoteToAdmin } = require("../../src/services/adminBootstrap");
const { adminGuard, auditedMutation } = require("../../src/middleware/admin");

async function agentFor(overrides) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

describeDb("admin area and audit log (database)", () => {
  useTestDb();

  async function adminAgent() {
    const made = await agentFor();
    await promoteToAdmin(made.user.email);
    return made;
  }

  describe("the guard", () => {
    test("a signed-in member gets 404 on every /admin page, GET and POST", async () => {
      const { agent } = await agentFor();
      for (const url of ["/admin", "/admin/audit"]) {
        expect((await agent.get(url)).status).toBe(404);
      }
      expect((await agent.post("/admin/audit").type("form").send({})).status).toBe(404);
    });

    test("an admin sees the landing page and the log", async () => {
      const { agent } = await adminAgent();
      const home = await agent.get("/admin");
      expect(home.status).toBe(200);
      expect(home.headers["cache-control"]).toMatch(/no-store/);
      const log = await agent.get("/admin/audit");
      expect(log.status).toBe(200);
      expect(log.text).toMatch(/user\.make_admin/);
    });

    test("an open session becomes an admin session at once, and loses it when suspended", async () => {
      const { agent, user } = await agentFor();
      expect((await agent.get("/admin")).status).toBe(404);
      await promoteToAdmin(user.email);
      expect((await agent.get("/admin")).status).toBe(200);
      await User.updateOne({ _id: user._id }, { status: "suspended" });
      expect((await agent.get("/admin")).status).toBe(404);
    });

    test("the Admin link is in the menu for admins only", async () => {
      const member = await agentFor();
      expect((await member.agent.get("/listings")).text).not.toMatch(/href="\/admin"/);
      const boss = await adminAgent();
      expect((await boss.agent.get("/listings")).text).toMatch(/href="\/admin"/);
    });
  });

  describe("the only way to become an admin", () => {
    test("signup ignores a role field", async () => {
      const agent = createAgent();
      const res = await agent
        .post("/signup")
        .type("form")
        .send({ username: "sneaky", email: "sneaky@example.com", password: "a-long-enough-password-1", role: "admin" });
      expect(res.status).toBe(302);
      const user = await User.findOne({ username: "sneaky" });
      expect(user.role).toBe("member");
    });

    test("the profile form refuses a role field", async () => {
      const { agent, user } = await agentFor();
      const res = await agent.put("/account/profile").type("form").send({ displayName: "Me", role: "admin" });
      expect(res.status).not.toBe(200);
      expect((await User.findById(user._id)).role).toBe("member");
    });

    test("make-admin promotes, writes exactly one audit row, and is idempotent", async () => {
      const { user } = await createUser();
      expect(await promoteToAdmin(user.email.toUpperCase())).toEqual({ changed: true, username: user.username });
      expect((await User.findById(user._id)).role).toBe("admin");
      expect(await promoteToAdmin(user.email)).toEqual({ changed: false, username: user.username });

      const rows = await AuditLog.find({ targetId: user._id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "user.make_admin", targetType: "user", actor: null, actorLabel: "cli:make-admin" });
      expect(rows[0].details).toEqual({ username: user.username, previousRole: "member" });
    });

    test("a suspended account is refused and nothing is written", async () => {
      const { user } = await createUser();
      await User.updateOne({ _id: user._id }, { status: "suspended" });
      await expect(promoteToAdmin(user.email)).rejects.toThrow(/suspended/);
      expect((await User.findById(user._id)).role).toBe("member");
      expect(await AuditLog.countDocuments({})).toBe(0);
    });
  });

  describe("the audit log is append-only", () => {
    const row = () => audit.record({ actorLabel: "test", action: "user.suspend", targetType: "user", reason: "r" });

    test("a stored row cannot be updated, replaced or deleted through the model", async () => {
      const saved = await row();
      await expect(AuditLog.updateOne({ _id: saved._id }, { reason: "changed" })).rejects.toThrow(/cannot be changed/);
      await expect(AuditLog.deleteOne({ _id: saved._id })).rejects.toThrow(/cannot be changed/);
      await expect(AuditLog.deleteMany({})).rejects.toThrow(/cannot be changed/);
      saved.reason = "changed";
      await expect(saved.save()).rejects.toThrow(/cannot be changed/);
      const again = await AuditLog.findById(saved._id);
      expect(again.reason).toBe("r");
    });

    test("rows have a creation time and no update time", async () => {
      const saved = await AuditLog.findById((await row())._id).lean();
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeUndefined();
    });

    test("the viewer pages through the rows, newest first", async () => {
      const { agent } = await adminAgent(); // 1 row (make_admin)
      for (let i = 0; i < audit.PAGE_SIZE + 4; i += 1) await row();
      const first = await agent.get("/admin/audit");
      expect(first.text).toMatch(/rel="next"/);
      const second = await agent.get("/admin/audit?page=2");
      expect(second.status).toBe(200);
      expect(second.text).toMatch(/user\.make_admin/); // the oldest row is on the last page
      expect((await agent.get("/admin/audit?page=999")).status).toBe(200);
      expect((await agent.get("/admin/audit?page[]=2&page[x]=1")).status).toBe(200);
    });
  });

  describe("auditedMutation in a real request", () => {
    // A throw-away app with the real guard and wrapper and two test-only routes.
    function appWithRoutes(user) {
      const app = express();
      app.use((req, res, next) => {
        req.user = user;
        req.id = "req-test";
        req.flash = () => {};
        next();
      });
      const router = express.Router();
      router.use(adminGuard);
      router.post(
        "/good",
        auditedMutation(async () => ({
          audit: { action: "user.suspend", targetType: "user", targetId: new mongoose.Types.ObjectId(), reason: "Spam" },
          redirectTo: "/admin/users",
        })),
      );
      router.post(
        "/forgot",
        auditedMutation(async () => ({ redirectTo: "/admin" })), // changed something, "forgot" to log it
      );
      app.use("/admin", router);
      app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
      return app;
    }

    test("one request, one audit row carrying the admin and the request id", async () => {
      const { user } = await createUser();
      user.role = "admin";
      const res = await request(appWithRoutes(user)).post("/admin/good");
      expect(res.status).toBe(302);
      const rows = await AuditLog.find({});
      expect(rows).toHaveLength(1);
      expect(rows[0].actor.equals(user._id)).toBe(true);
      expect(rows[0].requestId).toBe("req-test");
    });

    test("a mutation that logs nothing fails and writes nothing", async () => {
      const { user } = await createUser();
      user.role = "admin";
      const res = await request(appWithRoutes(user)).post("/admin/forgot");
      expect(res.status).toBe(500);
      expect(res.headers.location).toBeUndefined();
      expect(await AuditLog.countDocuments({})).toBe(0);
    });

    test("a non-admin cannot reach either route, and nothing is logged", async () => {
      const { user } = await createUser();
      for (const url of ["/admin/good", "/admin/forgot"]) {
        expect((await request(appWithRoutes(user)).post(url)).status).toBe(404);
      }
      expect(await AuditLog.countDocuments({})).toBe(0);
    });
  });
});
