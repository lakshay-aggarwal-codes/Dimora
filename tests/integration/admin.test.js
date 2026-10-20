// P14-T01 without a database: visitors cannot see /admin, and the admin views
// render (and escape) what they are given.
const { createAgent, createTestApp } = require("../helpers/agent");

describe("a visitor and /admin/*", () => {
  test.each(["/admin", "/admin/", "/admin/audit", "/admin/audit?page=2", "/admin/anything/else"])(
    "GET %s is the ordinary 404 page",
    async (url) => {
      const res = await createAgent().get(url);
      expect(res.status).toBe(404);
      expect(res.text).toMatch(/Page Not Found/);
      expect(res.text).not.toMatch(/Audit log/);
    },
  );

  test.each(["/admin", "/admin/audit", "/admin/users/1/suspend"])("POST %s does not redirect to a login page", async (url) => {
    const res = await createAgent().post(url).type("form").send({});
    expect(res.status).toBe(404);
  });

  test("a visitor's 404 does not say that an admin area exists", async () => {
    const res = await createAgent().get("/admin");
    expect(res.text).not.toMatch(/You must be logged in/);
    expect(res.headers.location).toBeUndefined();
  });
});

describe("admin views", () => {
  const app = createTestApp();
  const render = (view, locals) =>
    new Promise((resolve, reject) =>
      app.render(
        view,
        {
          pageTitle: "Audit log",
          success: [],
          error: [],
          currUser: { username: "boss", role: "admin" },
          can: () => true,
          csrfToken: "t",
          currentPath: "/admin/audit",
          cspNonce: "n",
          mapPublicToken: "",
          formatMoney: () => "",
          ...locals,
        },
        (err, html) => (err ? reject(err) : resolve(html)),
      ),
    );

  const log = (rows, extra) => ({ rows, page: 1, totalPages: 1, total: rows.length, ...extra });

  test("an empty log says so", async () => {
    const html = await render("admin/audit", { log: log([]) });
    expect(html).toMatch(/Nothing has been logged yet/);
    expect(html).not.toMatch(/<table/);
  });

  test("rows are shown newest-first as given, with actor, action and target", async () => {
    const html = await render("admin/audit", {
      log: log([
        {
          createdAt: new Date("2026-10-20T10:30:45.000Z"),
          actor: { username: "boss" },
          action: "user.suspend",
          targetType: "user",
          targetId: "64b64b64b64b64b64b64b64b",
          reason: "Spam",
          details: { from: "active", to: "suspended" },
        },
        {
          createdAt: new Date("2026-10-19T08:00:00.000Z"),
          actor: null,
          actorLabel: "cli:make-admin",
          action: "user.make_admin",
          targetType: "user",
        },
      ]),
    });
    expect(html).toMatch(/2026-10-20 10:30:45/);
    expect(html.indexOf("user.suspend")).toBeLessThan(html.indexOf("user.make_admin"));
    expect(html).toMatch(/cli:make-admin/);
    expect(html).toMatch(/Spam/);
  });

  test("nothing in a row can inject markup", async () => {
    const html = await render("admin/audit", {
      log: log([
        {
          createdAt: new Date("2026-10-20T10:30:45.000Z"),
          actor: { username: "<img src=x onerror=alert(1)>" },
          action: "user.suspend",
          targetType: "user",
          reason: "<script>alert(1)</script>",
          details: { note: "</code><script>alert(2)</script>" },
        },
      ]),
    });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)/);
  });

  test("the viewer has no form, button or link that could change an entry", async () => {
    const html = await render("admin/audit", {
      log: log([{ createdAt: new Date(), action: "user.suspend", targetType: "user", actor: { username: "boss" } }], {
        totalPages: 3,
      }),
    });
    const main = html.slice(html.indexOf('id="main"'), html.indexOf("<footer"));
    expect(main).not.toMatch(/<form/);
    expect(main).not.toMatch(/<button/);
    expect(main).not.toMatch(/method="post"/i);
  });

  test("pagination keeps to /admin/audit", async () => {
    const html = await render("admin/audit", { log: log([{ createdAt: new Date(), action: "a.b", targetType: "user" }], { page: 2, totalPages: 3 }) });
    expect(html).toMatch(/href="\/admin\/audit"/);
    expect(html).toMatch(/href="\/admin\/audit\?page=3"/);
  });

  test("the landing page links to the log", async () => {
    const html = await render("admin/index", { pageTitle: "Admin" });
    expect(html).toMatch(/href="\/admin\/audit"/);
    expect(html).toMatch(/make-admin/);
  });
});

describe("the navbar", () => {
  const ejs = require("ejs");
  const path = require("node:path");
  const file = path.join(__dirname, "..", "..", "views", "includes", "navbar.ejs");
  const nav = (can) =>
    ejs.renderFile(file, {
      currUser: { username: "ann" },
      currentPath: "/",
      csrfToken: "t",
      can,
    });

  test("shows the Admin link only when the policy allows it", async () => {
    expect(await nav((a) => a === "admin:access")).toMatch(/href="\/admin"/);
    expect(await nav(() => false)).not.toMatch(/href="\/admin"/);
  });

  test("a page rendered without the can() helper still works", async () => {
    await expect(nav(undefined)).resolves.not.toMatch(/href="\/admin"/);
  });
});
