// P14-T05 against a real MongoDB: the platform summary, the read-only
// reservation lookup and the audit log filters. Skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing, createCompletedStay } = require("../helpers/factories");
const User = require("../../src/models/user");
const Reservation = require("../../src/models/reservation");
const Report = require("../../src/models/report");
const AuditLog = require("../../src/models/auditLog");
const { KIND_VALUES, REASON_VALUES } = require("../../src/config/reports");
const { promoteToAdmin } = require("../../src/services/adminBootstrap");
const { platformSummary } = require("../../src/services/adminSummary");
const { listAudit } = require("../../src/services/audit");

async function agentFor(overrides) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user, password };
}
async function adminAgent(overrides) {
  const made = await agentFor(overrides);
  await promoteToAdmin(made.user.email);
  return made;
}

describeDb("admin overview, reservation lookup and audit filters (database)", () => {
  useTestDb();

  describe("platform summary", () => {
    test("counts users, listings, reservations by status and open reports, and nothing else", async () => {
      const boss = await adminAgent();
      const { user: host } = await createUser();
      const { user: guest } = await createUser();
      const { user: banned } = await createUser();
      await User.updateOne({ _id: banned._id }, { status: "suspended" });

      const live = await createListing({ owner: host, status: "published" });
      await createListing({ owner: host, status: "published" });
      await createListing({ owner: host, status: "draft" });
      await createListing({ owner: host, status: "suspended" });
      await createListing({ owner: host, status: "published", deletedAt: new Date() }); // removed by its host: not counted

      await createCompletedStay({ listing: live, guest });
      await createCompletedStay({ listing: live, guest });
      await createCompletedStay({ listing: live, guest, status: "pending", holdExpiresAt: new Date(Date.now() + 3600e3) });
      await createCompletedStay({ listing: live, guest, status: "cancelled_by_guest" });

      const common = { reporter: guest._id, targetKind: KIND_VALUES[0], reason: REASON_VALUES[0] };
      await Report.create({ ...common, targetId: live._id });
      await Report.create({ ...common, targetId: host._id, status: "resolved" });

      const summary = await platformSummary();
      expect(summary.users).toEqual({
        byStatus: { active: 3, suspended: 1, deleted: 0 },
        total: 4,
        admins: 1,
      });
      expect(summary.listings).toEqual({
        byStatus: { draft: 1, published: 2, unpublished: 0, suspended: 1 },
        total: 4,
      });
      expect(summary.reservations.byStatus).toEqual({
        pending: 1,
        confirmed: 0,
        declined: 0,
        expired: 0,
        cancelled_by_guest: 1,
        cancelled_by_host: 0,
        completed: 2,
      });
      expect(summary.reservations.total).toBe(4);
      expect(summary.openReports).toBe(1);

      const page = await boss.agent.get("/admin");
      expect(page.status).toBe(200);
      expect(page.text).toMatch(/Platform summary/);
      expect(page.text).toMatch(/<strong>1<\/strong> open/);
      expect(page.text).toMatch(/href="\/admin\/reservations"/);
    });

    test("an empty database shows zeros, not errors", async () => {
      const boss = await adminAgent();
      const summary = await platformSummary();
      expect(summary.listings.total).toBe(0);
      expect(summary.reservations.total).toBe(0);
      expect(summary.openReports).toBe(0);
      expect((await boss.agent.get("/admin")).status).toBe(200);
    });
  });

  describe("reservation lookup", () => {
    async function world() {
      const boss = await adminAgent();
      const { user: host } = await createUser({ username: "hosty" });
      const ann = await createUser({ username: "annabel", email: "annabel@example.com" });
      const bob = await createUser({ username: "bobby", email: "bobby@example.com" });
      const lake = await createListing({ owner: host, title: "Lakeside Cabin" });
      const city = await createListing({ owner: host, title: "City Loft" });
      const r1 = await createCompletedStay({ listing: lake, guest: ann.user });
      const r2 = await createCompletedStay({ listing: city, guest: ann.user, status: "cancelled_by_guest" });
      const r3 = await createCompletedStay({ listing: city, guest: bob.user, status: "confirmed" });
      return { boss, host, ann: ann.user, bob: bob.user, lake, city, r1, r2, r3 };
    }
    const has = (res, r) => res.text.includes(`/admin/reservations/${r._id}`);

    test("a member and a visitor get 404", async () => {
      const { r1 } = await world();
      const { agent } = await agentFor();
      for (const url of ["/admin/reservations", `/admin/reservations/${r1._id}`]) {
        expect((await agent.get(url)).status).toBe(404);
        expect((await createAgent().get(url)).status).toBe(404);
      }
    });

    test("lists every reservation, newest first, with no query", async () => {
      const { boss, r1, r2, r3 } = await world();
      const res = await boss.agent.get("/admin/reservations");
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/3 reservations/);
      for (const r of [r1, r2, r3]) expect(has(res, r)).toBe(true);
    });

    test("finds by reservation id, guest id, host id and listing id", async () => {
      const { boss, host, ann, city, r1, r2, r3 } = await world();
      let res = await boss.agent.get(`/admin/reservations?q=${r1._id}`);
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, false, false]);
      res = await boss.agent.get(`/admin/reservations?q=${ann._id}`);
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, true, false]);
      res = await boss.agent.get(`/admin/reservations?q=${city._id}`);
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([false, true, true]);
      res = await boss.agent.get(`/admin/reservations?q=${host._id}`);
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, true, true]);
    });

    test("finds by part of a guest's username or email and by listing title, ignoring case", async () => {
      const { boss, r1, r2, r3 } = await world();
      let res = await boss.agent.get("/admin/reservations?q=ANNA");
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, true, false]);
      res = await boss.agent.get("/admin/reservations?q=bobby@example");
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([false, false, true]);
      res = await boss.agent.get("/admin/reservations?q=lakeside");
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, false, false]);
    });

    test("text is matched as plain text, never as a pattern", async () => {
      const { boss } = await world();
      for (const q of [".*", "^a", "(", "[a-z]+"]) {
        const res = await boss.agent.get(`/admin/reservations?q=${encodeURIComponent(q)}`);
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/0 reservations/);
        expect(res.text).toMatch(/No reservations match/);
      }
    });

    test("filters by status, alone and with a search; an unknown status is ignored", async () => {
      const { boss, r1, r2, r3 } = await world();
      let res = await boss.agent.get("/admin/reservations?status=cancelled_by_guest");
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([false, true, false]);
      res = await boss.agent.get("/admin/reservations?status=completed&q=annabel");
      expect([has(res, r1), has(res, r2), has(res, r3)]).toEqual([true, false, false]);
      res = await boss.agent.get("/admin/reservations?status=bogus");
      expect(res.text).toMatch(/3 reservations/);
    });

    test("malformed input never breaks the page", async () => {
      const { boss } = await world();
      for (const url of [
        "/admin/reservations?q=a&q=b",
        "/admin/reservations?q[$ne]=x",
        "/admin/reservations?page=-5",
        "/admin/reservations?page=abc",
        "/admin/reservations?status[]=x",
      ]) {
        expect((await boss.agent.get(url)).status).toBe(200);
      }
    });

    test("the detail page shows people, price, history and refund, escaped, with nothing to change it", async () => {
      const { boss, r2 } = await world();
      await Reservation.updateOne(
        { _id: r2._id },
        {
          cancelReason: "<script>alert(1)</script>",
          cancelledBy: "guest",
          refund: { amountMinor: 100000, retainedMinor: 200000, totalMinor: 300000, currency: "INR", policy: "moderate", rule: "first night kept" },
          statusHistory: [
            { from: null, to: "confirmed", at: new Date("2026-03-01T10:00:00Z"), actor: "guest" },
            { from: "confirmed", to: "cancelled_by_guest", at: new Date("2026-03-02T10:00:00Z"), actor: "guest", note: "Plans changed" },
          ],
        },
      );
      const res = await boss.agent.get(`/admin/reservations/${r2._id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("annabel");
      expect(res.text).toContain("City Loft");
      expect(res.text).toMatch(/cancelled by guest/);
      expect(res.text).toMatch(/Plans changed/);
      expect(res.text).toMatch(/first night kept/);
      expect(res.text).toMatch(/2026-03-02 10:00:00/);
      expect(res.text).not.toContain("<script>alert(1)</script>");
      expect(res.text).toContain("&lt;script&gt;");
      expect(res.text).not.toMatch(/action="\/admin\/reservations/); // no form that could change it
    });

    test("unknown and malformed ids are 404; no route changes a reservation", async () => {
      const { boss, r3 } = await world();
      expect((await boss.agent.get("/admin/reservations/not-an-id")).status).toBe(404);
      expect((await boss.agent.get("/admin/reservations/000000000000000000000000")).status).toBe(404);
      for (const [method, url] of [
        ["post", `/admin/reservations/${r3._id}/cancel`],
        ["post", `/admin/reservations/${r3._id}`],
        ["delete", `/admin/reservations/${r3._id}`],
      ]) {
        expect((await boss.agent[method](url).type("form").send({})).status).toBe(404);
      }
      expect((await Reservation.findById(r3._id)).status).toBe("confirmed");
      expect(await AuditLog.countDocuments({ targetType: "reservation" })).toBe(0);
    });

    test("looking things up writes no audit rows", async () => {
      const { boss, r1 } = await world();
      const before = await AuditLog.countDocuments({});
      await boss.agent.get("/admin");
      await boss.agent.get("/admin/reservations?q=anna");
      await boss.agent.get(`/admin/reservations/${r1._id}`);
      expect(await AuditLog.countDocuments({})).toBe(before);
    });
  });

  describe("audit log filters", () => {
    async function logs() {
      const boss = await adminAgent({ username: "chief" });
      const mk = (fields, at) => AuditLog.collection.insertOne({ targetId: null, ...fields, createdAt: new Date(at) });
      const a = (await mk({ actor: boss.user._id, action: "user.suspend", targetType: "user", reason: "spam" }, "2026-03-10T12:00:00Z")).insertedId;
      const b = (await mk({ actor: boss.user._id, action: "listing.suspend", targetType: "listing" }, "2026-03-12T08:00:00Z")).insertedId;
      const c = (await mk({ actor: null, actorLabel: "cli:make-admin", action: "user.make_admin", targetType: "user" }, "2026-03-15T23:59:00Z")).insertedId;
      return { boss, a, b, c };
    }
    const ids = (log) => log.rows.map((r) => String(r._id));
    const mine = (log, { a, b, c }) => [a, b, c].filter((x) => ids(log).includes(String(x))).map(String);

    test("no filter lists everything, newest first", async () => {
      const set = await logs();
      const log = await listAudit({});
      expect(ids(log).indexOf(String(set.c))).toBeLessThan(ids(log).indexOf(String(set.b)));
      expect(ids(log).indexOf(String(set.b))).toBeLessThan(ids(log).indexOf(String(set.a)));
      expect(log.filters).toEqual({ action: "", actor: "", targetType: "", from: "", to: "" });
    });

    test("action: an exact name or a prefix", async () => {
      const set = await logs();
      expect(mine(await listAudit({ action: "user.suspend" }), set)).toEqual([String(set.a)]);
      expect(mine(await listAudit({ action: "user." }), set)).toEqual([String(set.a), String(set.c)]);
      expect(mine(await listAudit({ action: "listing" }), set)).toEqual([String(set.b)]);
      expect(mine(await listAudit({ action: "User.Suspend" }), set)).toEqual([String(set.a)]); // case-insensitive input
    });

    test("target type", async () => {
      const set = await logs();
      expect(mine(await listAudit({ targetType: "listing" }), set)).toEqual([String(set.b)]);
      expect(mine(await listAudit({ targetType: "nonsense" }), set)).toEqual([String(set.a), String(set.b), String(set.c)]);
    });

    test("actor: an admin's username (any case) or the label of a script", async () => {
      const set = await logs();
      expect(mine(await listAudit({ actor: "CHIEF" }), set)).toEqual([String(set.a), String(set.b)]);
      expect(mine(await listAudit({ actor: "cli:make-admin" }), set)).toEqual([String(set.c)]);
      expect(mine(await listAudit({ actor: "nobody" }), set)).toEqual([]);
    });

    test("dates are UTC days and both ends are inclusive", async () => {
      const set = await logs();
      expect(mine(await listAudit({ from: "2026-03-11", to: "2026-03-12" }), set)).toEqual([String(set.b)]);
      expect(mine(await listAudit({ to: "2026-03-10" }), set)).toEqual([String(set.a)]);
      expect(mine(await listAudit({ from: "2026-03-15" }), set)).toEqual([String(set.c)]);
      expect(mine(await listAudit({ from: "2026-03-16" }), set)).toEqual([]);
    });

    test("filters combine; a bad value is ignored instead of failing", async () => {
      const set = await logs();
      expect(mine(await listAudit({ action: "user.", actor: "chief" }), set)).toEqual([String(set.a)]);
      const odd = await listAudit({ from: "2026-13-45", to: "yesterday", action: ".*", actor: "x".repeat(500) });
      expect(odd.filters.from).toBe("");
      expect(odd.filters.to).toBe("");
      expect(odd.filters.action).toBe("");
      expect(odd.filters.actor).toHaveLength(80);
    });

    test("the page applies them, keeps them in the form and clears them", async () => {
      const { boss } = await logs();
      const res = await boss.agent.get("/admin/audit?action=listing.&targetType=listing&from=2026-03-01");
      expect(res.status).toBe(200);
      expect(res.text).toContain("listing.suspend");
      expect(res.text).not.toContain("spam");
      expect(res.text).toMatch(/value="listing\."/);
      expect(res.text).toMatch(/value="2026-03-01"/);
      expect(res.text).toMatch(/Clear filters/);
      const none = await boss.agent.get("/admin/audit?action=zzz");
      expect(none.text).toMatch(/No entries match/);
      expect((await boss.agent.get("/admin/audit?action[$ne]=x&actor[]=y")).status).toBe(200);
    });

    test("the filters stay in the pagination links", async () => {
      const { boss } = await logs();
      const many = Array.from({ length: 30 }, (_, i) => ({
        actor: boss.user._id, action: "user.suspend", targetType: "user", targetId: null,
        createdAt: new Date(Date.UTC(2026, 4, 1, 0, i)),
      }));
      await AuditLog.collection.insertMany(many);
      const res = await boss.agent.get("/admin/audit?action=user.suspend");
      expect(res.text).toMatch(/href="[^"]*action=user\.suspend[^"]*page=2|href="[^"]*page=2[^"]*action=user\.suspend/);
    });
  });
});
