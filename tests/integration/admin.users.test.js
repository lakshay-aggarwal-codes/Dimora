// P14-T02 without a database: the user pages render, escape what they are
// given, and offer the right form for the account's state.
const { createTestApp } = require("../helpers/agent");

const app = createTestApp();
const render = (view, locals) =>
  new Promise((resolve, reject) =>
    app.render(
      view,
      {
        pageTitle: "Users",
        success: [],
        error: [],
        currUser: { username: "boss", role: "admin" },
        can: () => true,
        csrfToken: "tok123",
        currentPath: "/admin/users",
        cspNonce: "n",
        mapPublicToken: "",
        formatMoney: () => "",
        ...locals,
      },
      (err, html) => (err ? reject(err) : resolve(html)),
    ),
  );

const person = (extra) => ({
  _id: "64b64b64b64b64b64b64b64b",
  username: "ann",
  email: "ann@example.com",
  displayName: "Ann",
  role: "member",
  status: "active",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  ...extra,
});
const result = (rows, extra) => ({ rows, page: 1, totalPages: 1, total: rows.length, q: "", status: "", ...extra });
const summary = (user, extra) => ({
  user,
  activity: { listings: { draft: 1, published: 2, unpublished: 0, suspended: 0, total: 3 }, reviewsWritten: 4 },
  reservations: { pending: 0, confirmed: 0 },
  history: [],
  ...extra,
});
const main = (html) => html.slice(html.indexOf('id="main"'), html.indexOf("<footer"));

describe("admin/users", () => {
  test("lists accounts with a link to each and a status label", async () => {
    const html = await render("admin/users", { result: result([person(), person({ _id: "64b64b64b64b64b64b64b64c", username: "bob", status: "suspended" })]) });
    expect(html).toMatch(/href="\/admin\/users\/64b64b64b64b64b64b64b64b"/);
    expect(html).toMatch(/suspended/);
    expect(html).toMatch(/2026-08-01/);
    expect(html).toMatch(/2 accounts/);
  });

  test("an empty result says so", async () => {
    const html = await render("admin/users", { result: result([]) });
    expect(html).toMatch(/No accounts match/);
    expect(html).not.toMatch(/<table/);
  });

  test("the search form is a GET and keeps the typed text and status", async () => {
    const html = await render("admin/users", { result: result([person()], { q: "an\"n", status: "suspended" }) });
    expect(html).toMatch(/method="GET"/);
    expect(html).toMatch(/value="an&#34;n"/);
    expect(html).toMatch(/<option value="suspended" selected>/);
  });

  test("pagination keeps the search", async () => {
    const html = await render("admin/users", { result: result([person()], { q: "ann", page: 2, totalPages: 3 }) });
    expect(html).toMatch(/href="\/admin\/users\?q=ann&amp;page=3"/);
  });

  test("nothing in a row can inject markup", async () => {
    const html = await render("admin/users", { result: result([person({ username: "<img src=x onerror=alert(1)>", email: "<script>alert(2)</script>@x.com", displayName: "<b>x</b>" })]) });
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<b>x<\/b>/);
  });

  test("the list never shows a hash or salt", async () => {
    const html = await render("admin/users", { result: result([person({ hash: "HASHVALUE", salt: "SALTVALUE" })]) });
    expect(html).not.toMatch(/HASHVALUE|SALTVALUE/);
  });
});

describe("admin/user", () => {
  test("an active account offers Suspend with a required reason and the CSRF token", async () => {
    const html = main(await render("admin/user", { summary: summary(person()), isSelf: false }));
    expect(html).toMatch(/action="\/admin\/users\/64b64b64b64b64b64b64b64b\/suspend" method="POST"/);
    expect(html).toMatch(/name="_csrf" value="tok123"/);
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(html).not.toMatch(/\/reinstate/);
  });

  test("a suspended account offers Reinstate only", async () => {
    const html = main(await render("admin/user", { summary: summary(person({ status: "suspended" })), isSelf: false }));
    expect(html).toMatch(/\/reinstate" method="POST"/);
    expect(html).not.toMatch(/\/suspend"/);
  });

  test("your own account has no suspend form", async () => {
    const html = main(await render("admin/user", { summary: summary(person({ role: "admin" })), isSelf: true }));
    expect(html).not.toMatch(/<form/);
    expect(html).toMatch(/cannot suspend your own account/);
  });

  test("a deleted account has no form at all", async () => {
    const html = main(await render("admin/user", { summary: summary(person({ status: "deleted" })), isSelf: false }));
    expect(html).not.toMatch(/<form/);
  });

  test("shows the activity summary and the admin history, escaped", async () => {
    const html = await render("admin/user", {
      summary: summary(person(), {
        history: [
          {
            createdAt: new Date("2026-10-20T10:30:45.000Z"),
            actor: { username: "boss" },
            action: "user.suspend",
            reason: "<script>alert(1)</script>",
          },
        ],
      }),
      isSelf: false,
    });
    expect(html).toMatch(/Listings: 3 \(2 published, 1 draft/);
    expect(html).toMatch(/Reviews written: 4/);
    expect(html).toMatch(/2026-10-20 10:30:45/);
    expect(html).toMatch(/user\.suspend/);
    expect(html).not.toMatch(/<script>alert/);
  });
});

describe("admin landing page", () => {
  test("links to Users", async () => {
    expect(await render("admin/index", { pageTitle: "Admin" })).toMatch(/href="\/admin\/users"/);
  });
});
