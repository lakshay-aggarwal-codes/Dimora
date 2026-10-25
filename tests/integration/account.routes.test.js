// P02-T04: /account through the real router, validation, controller and EJS
// (layout included), the service stubbed (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const accountService = require("../../src/services/account");
const accountRouter = require("../../src/routes/account");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const me = {
  _id: new ObjectId(),
  username: "ann_lee",
  email: "ann.lee@example.com",
  role: "member",
  status: "active",
};

function setup(user = me) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "views"));
  app.engine("ejs", ejsMate);
  Object.assign(app.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
  app.use(express.urlencoded({ extended: false }));
  const log = { flashes: [], logins: 0, logouts: 0 };
  app.use((req, res, next) => {
    req.user = user || undefined;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = (type, message) => {
      if (message) log.flashes.push([type, message]);
      return [];
    };
    req.logIn = (u, cb) => {
      log.logins += 1;
      cb();
    };
    req.logout = (cb) => {
      log.logouts += 1;
      cb();
    };
    Object.assign(res.locals, {
      success: [],
      error: [],
      currUser: user,
      currentPath: req.path,
      formatMoney,
      mapPublicToken: "",
      csrfToken: "tok",
      cspNonce: "n",
    });
    res.locals.can = (a, r) => can(a, user, r);
    next();
  });
  app.use("/", accountRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) =>
    res.status(err.statusCode || 500).send(String(err.message)),
  );
  return { app, log };
}

const goodPassword = {
  currentPassword: "old-Password-1",
  newPassword: "A-better-passphrase-9",
  confirmPassword: "A-better-passphrase-9",
};

describe("GET /account", () => {
  test("signed out: redirect to log in, no data read", async () => {
    const blockers = jest
      .spyOn(accountService, "deletionBlockers")
      .mockResolvedValue([]);
    const res = await request(setup(null).app).get("/account");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(blockers).not.toHaveBeenCalled();
  });

  test("both forms with CSRF tokens, labelled fields, no pre-filled password", async () => {
    jest.spyOn(accountService, "deletionBlockers").mockResolvedValue([]);
    const res = await request(setup().app).get("/account");
    expect(res.status).toBe(200);
    expect(res.text).toContain('action="/account/password"');
    expect(res.text).toContain('action="/account/delete"');
    for (const action of ["/account/password", "/account/delete"]) {
      const form = res.text.slice(res.text.indexOf(`action="${action}"`));
      expect(form.slice(0, form.indexOf("</form>"))).toContain('name="_csrf" value="tok"');
    }
    for (const id of [
      "currentPassword",
      "newPassword",
      "confirmPassword",
      "deletePassword",
      "deleteConfirm",
    ]) {
      expect(res.text).toContain(`<label class="form-label" for="${id}">`);
      expect(res.text).toMatch(new RegExp(`id="${id}"[^>]*required`));
    }
    expect(res.text).not.toMatch(/type="password"[^>]*value=/);
    expect(res.text).toContain('autocomplete="new-password"');
    expect(res.text).toContain('autocomplete="current-password"');
    expect(res.text).not.toContain("data-blockers");
  });

  test("blockers are listed before the delete button, each with its code", async () => {
    jest.spyOn(accountService, "deletionBlockers").mockResolvedValue([
      {
        code: "guest_confirmed",
        message:
          "You have 2 confirmed stays that have not ended. Cancel them or wait until the stay is over.",
      },
      {
        code: "host_pending",
        message:
          "1 request is waiting for your answer. Accept or decline it first.",
      },
    ]);
    const res = await request(setup().app).get("/account");
    expect(res.text).toContain("You cannot delete your account yet:");
    expect(res.text).toContain('data-blocker="guest_confirmed"');
    expect(res.text).toContain('data-blocker="host_pending"');
    expect(res.text.indexOf("data-blockers")).toBeLessThan(
      res.text.indexOf('action="/account/delete"'),
    );
  });

  test("the account menu links to it", async () => {
    jest.spyOn(accountService, "deletionBlockers").mockResolvedValue([]);
    expect((await request(setup().app).get("/account")).text).toContain(
      'href="/account"',
    );
  });
});

describe("POST /account/password", () => {
  test("a good change: the service gets both passwords, the session is renewed, a message", async () => {
    const change = jest
      .spyOn(accountService, "changePassword")
      .mockResolvedValue();
    const { app, log } = setup();
    const res = await request(app)
      .post("/account/password")
      .type("form")
      .send(goodPassword);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/account");
    expect(change).toHaveBeenCalledWith({
      user: me,
      currentPassword: "old-Password-1",
      newPassword: "A-better-passphrase-9",
    });
    expect(log.logins).toBe(1);
    expect(log.flashes).toEqual([["success", "Your password was changed."]]);
  });

  test.each([
    [
      "a weak new password",
      {
        ...goodPassword,
        newPassword: "password123",
        confirmPassword: "password123",
      },
      "too common",
    ],
    [
      "a mismatch",
      { ...goodPassword, confirmPassword: "Another-passphrase-1" },
      "do not match",
    ],
    [
      "no current password",
      { ...goodPassword, currentPassword: "" },
      "Enter your current password",
    ],
    [
      "the same password",
      {
        currentPassword: "Same-Password-123",
        newPassword: "Same-Password-123",
        confirmPassword: "Same-Password-123",
      },
      "different from the current",
    ],
    [
      "the username as the password",
      { ...goodPassword, newPassword: "ann.lee", confirmPassword: "ann.lee" },
      "at least 10",
    ],
    ["an empty form", {}, "Enter your current password"],
  ])(
    "%s: back to the form with a message, nothing changed, no new session",
    async (_n, body, text) => {
      const change = jest
        .spyOn(accountService, "changePassword")
        .mockResolvedValue();
      const { app, log } = setup();
      const res = await request(app)
        .post("/account/password")
        .type("form")
        .send(body);
      expect(res.headers.location).toBe("/account");
      expect(change).not.toHaveBeenCalled();
      expect(log.logins).toBe(0);
      expect(log.flashes[0][0]).toBe("error");
      expect(log.flashes[0][1]).toContain(text);
    },
  );

  test("the new password may not be the name part of the member's own email", async () => {
    const change = jest
      .spyOn(accountService, "changePassword")
      .mockResolvedValue();
    const { app, log } = setup({
      ...me,
      username: "x",
      email: "longerthanten@example.com",
    });
    await request(app)
      .post("/account/password")
      .type("form")
      .send({
        ...goodPassword,
        newPassword: "longerthanten",
        confirmPassword: "longerthanten",
      });
    expect(change).not.toHaveBeenCalled();
    expect(log.flashes[0][1]).toContain(
      "must not be the same as your username or email",
    );
  });

  test.each([
    [
      "a wrong current password",
      new accountService.AccountRefusal(
        "Your current password is not correct.",
        "wrong_password",
      ),
    ],
    [
      "a locked account",
      new accountService.AccountRefusal(
        "Too many wrong passwords. Wait a few minutes and try again.",
        "locked",
      ),
    ],
  ])("%s: the message, no new session", async (_n, refusal) => {
    jest.spyOn(accountService, "changePassword").mockRejectedValue(refusal);
    const { app, log } = setup();
    const res = await request(app)
      .post("/account/password")
      .type("form")
      .send(goodPassword);
    expect(res.headers.location).toBe("/account");
    expect(log.flashes).toEqual([["error", refusal.message]]);
    expect(log.logins).toBe(0);
  });

  test("an unexpected failure is an error page, never 'wrong password'", async () => {
    jest
      .spyOn(accountService, "changePassword")
      .mockRejectedValue(new Error("database is down"));
    const res = await request(setup().app)
      .post("/account/password")
      .type("form")
      .send(goodPassword);
    expect(res.status).toBe(500);
  });

  test("signed out: nothing runs", async () => {
    const change = jest
      .spyOn(accountService, "changePassword")
      .mockResolvedValue();
    const res = await request(setup(null).app)
      .post("/account/password")
      .type("form")
      .send(goodPassword);
    expect([301, 302, 303]).toContain(res.status);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("POST /account/delete", () => {
  test("allowed: the service is called with the password, the member is logged out, a message, to the home page", async () => {
    const del = jest
      .spyOn(accountService, "deleteAccount")
      .mockResolvedValue({ id: me._id, unpublished: 1 });
    const { app, log } = setup();
    const res = await request(app)
      .post("/account/delete")
      .type("form")
      .send({ password: "my-password", confirm: "DELETE" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(del).toHaveBeenCalledWith({ user: me, password: "my-password" });
    expect(log.logouts).toBe(1);
    expect(log.flashes).toEqual([["success", "Your account was deleted."]]);
  });

  test.each([
    ["no confirmation word", { password: "x" }, "Type DELETE"],
    [
      "a wrong confirmation word",
      { password: "x", confirm: "delete" },
      "Type DELETE",
    ],
    ["no password", { confirm: "DELETE" }, "Enter your password"],
  ])(
    "%s: nothing is deleted and the member stays logged in",
    async (_n, body, text) => {
      const del = jest
        .spyOn(accountService, "deleteAccount")
        .mockResolvedValue({});
      const { app, log } = setup();
      const res = await request(app)
        .post("/account/delete")
        .type("form")
        .send(body);
      expect(res.headers.location).toBe("/account");
      expect(del).not.toHaveBeenCalled();
      expect(log.logouts).toBe(0);
      expect(log.flashes[0][1]).toContain(text);
    },
  );

  test("blocked: every blocker's sentence is shown, nobody is logged out", async () => {
    jest.spyOn(accountService, "deleteAccount").mockRejectedValue(
      new accountService.AccountRefusal(
        "Your account cannot be deleted yet.",
        "blocked",
        {
          blockers: [
            {
              code: "guest_confirmed",
              message: "You have 1 confirmed stay that has not ended.",
            },
            {
              code: "host_pending",
              message: "2 requests are waiting for your answer.",
            },
          ],
        },
      ),
    );
    const { app, log } = setup();
    const res = await request(app)
      .post("/account/delete")
      .type("form")
      .send({ password: "x", confirm: "DELETE" });
    expect(res.headers.location).toBe("/account");
    expect(log.logouts).toBe(0);
    expect(log.flashes[0][1]).toBe(
      "Your account cannot be deleted yet. You have 1 confirmed stay that has not ended. 2 requests are waiting for your answer.",
    );
  });

  test("a wrong password is told, and nobody is logged out", async () => {
    jest
      .spyOn(accountService, "deleteAccount")
      .mockRejectedValue(
        new accountService.AccountRefusal(
          "That password is not correct.",
          "wrong_password",
        ),
      );
    const { app, log } = setup();
    await request(app)
      .post("/account/delete")
      .type("form")
      .send({ password: "x", confirm: "DELETE" });
    expect(log.flashes).toEqual([["error", "That password is not correct."]]);
    expect(log.logouts).toBe(0);
  });

  test("an unexpected failure is an error page and nobody is logged out", async () => {
    jest
      .spyOn(accountService, "deleteAccount")
      .mockRejectedValue(new Error("boom"));
    const { app, log } = setup();
    expect(
      (
        await request(app)
          .post("/account/delete")
          .type("form")
          .send({ password: "x", confirm: "DELETE" })
      ).status,
    ).toBe(500);
    expect(log.logouts).toBe(0);
  });

  test("signed out: nothing runs", async () => {
    const del = jest
      .spyOn(accountService, "deleteAccount")
      .mockResolvedValue({});
    const res = await request(setup(null).app)
      .post("/account/delete")
      .type("form")
      .send({ password: "x", confirm: "DELETE" });
    expect([301, 302, 303]).toContain(res.status);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("mounted in the real app", () => {
  const { createAgent } = require("../helpers/agent");
  test("a signed-out visitor is sent to log in, GET and POST", async () => {
    const agent = createAgent();
    expect((await agent.get("/account")).headers.location).toMatch(/^\/login/);
    const post = await agent.post("/account/delete");
    expect([301, 302, 303]).toContain(post.status);
    expect(post.headers.location).toMatch(/^\/login/);
  });
});
