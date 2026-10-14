// P02-T02 through the real app and views, without a database: validation fails
// before the database is reached, and the passport "authenticate" step is
// stubbed where a login has to succeed.
const mongoose = require("mongoose");
const { createAgent } = require("../helpers/agent");
const User = require("../../src/models/user");
const { MESSAGES } = require("../../src/controllers/user");

const sidOf = (res) => {
  const cookies = [].concat(res.headers["set-cookie"] || []);
  const hit = cookies.find((c) => c.startsWith("connect.sid="));
  return hit ? hit.split(";")[0] : null;
};

/** Follows a redirect to the page that shows the flash message. */
async function flashAfter(agent, res, path) {
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(path);
  return (await agent.get(path)).text;
}

const stubAuth = (user, info) =>
  jest
    .spyOn(User, "authenticate")
    .mockReturnValue((u, p, done) => done(null, user, info));

const form = { username: "ann_01", password: "whatever-password" };

afterEach(() => {
  jest.restoreAllMocks();
});

describe("signup validation (no database needed)", () => {
  async function weakSignup(body) {
    const register = jest.spyOn(User, "register");
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send(body);
    const page = await flashAfter(agent, res, "/signup");
    return { page, register };
  }

  test("a short password goes back to the form with a clear message; nothing is saved", async () => {
    const { page, register } = await weakSignup({
      username: "ann_01",
      email: "ann@example.com",
      password: "short",
    });
    expect(page).toContain("Password must be at least 10 characters.");
    expect(register).not.toHaveBeenCalled();
  });

  test("a common password is refused", async () => {
    const { page, register } = await weakSignup({
      username: "ann_01",
      email: "ann@example.com",
      password: "Password123",
    });
    expect(page).toContain("too common");
    expect(register).not.toHaveBeenCalled();
  });

  test("several problems are shown together as readable sentences", async () => {
    const { page } = await weakSignup({
      username: "a b",
      email: "nope",
      password: "x",
    });
    expect(page).toContain(
      "Username can only contain letters, numbers and underscores.",
    );
    expect(page).toContain("Enter a valid email address.");
    expect(page).toContain("Password must be at least 10 characters.");
    expect(page).not.toMatch(/must be a string|is not allowed|fails to match/);
  });

  test("an over-long password is refused without hashing it", async () => {
    const { page, register } = await weakSignup({
      username: "ann_01",
      email: "ann@example.com",
      password: "x9".repeat(200),
    });
    expect(page).toContain("at most 128 characters");
    expect(register).not.toHaveBeenCalled();
  });

  test("a missing body field is a form error, not a crash", async () => {
    const { page } = await weakSignup({ username: "ann_01" });
    expect(page).toContain("Enter your email address.");
    expect(page).toContain("Choose a password.");
  });

  test("array/object values in the form are refused", async () => {
    const register = jest.spyOn(User, "register");
    const agent = createAgent();
    const res = await agent
      .post("/signup")
      .type("form")
      .send("username[$ne]=x&email=a@example.com&password=a-long-pass-phrase");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/signup");
    expect(register).not.toHaveBeenCalled();
  });

  test("role/status fields in the form are ignored", async () => {
    let saved;
    jest.spyOn(User, "register").mockImplementation(async (doc) => {
      saved = doc;
      throw Object.assign(new Error("x"), { name: "UserExistsError" });
    });
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send({
      username: "ann_01",
      email: "ann@example.com",
      password: "a-long-pass-phrase",
      role: "admin",
      status: "suspended",
      emailVerifiedAt: "2020-01-01",
    });
    const page = await flashAfter(agent, res, "/signup");
    expect(page).toContain(MESSAGES.usernameTaken);
    expect(saved.role).toBe("member");
    expect(saved.status).toBe("active");
    expect(saved.emailVerifiedAt).toBeNull();
  });
});

describe("signup error messages never come from the driver", () => {
  const valid = {
    username: "ann_01",
    email: "ann@example.com",
    password: "a-long-pass-phrase",
  };

  async function signupFailingWith(err) {
    jest.spyOn(User, "register").mockRejectedValue(err);
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send(valid);
    return flashAfter(agent, res, "/signup");
  }

  test("duplicate email: neutral text that does not confirm the address exists", async () => {
    const page = await signupFailingWith(
      Object.assign(
        new Error(
          "E11000 duplicate key error collection: dimora.users index: email_1",
        ),
        { code: 11000, keyPattern: { email: 1 } },
      ),
    );
    expect(page).toContain("couldn&#39;t create an account with those details");
    expect(page).not.toMatch(
      /E11000|duplicate|already exists|already registered|index/i,
    );
  });

  test("taken username: its own plain message", async () => {
    const page = await signupFailingWith(
      Object.assign(
        new Error("A user with the given username is already registered"),
        { name: "UserExistsError" },
      ),
    );
    expect(page).toContain("That username is already taken.");
  });

  test("a duplicate-key error on the username index is the same message", async () => {
    const page = await signupFailingWith(
      Object.assign(new Error("E11000 ... username_1"), {
        code: 11000,
        keyPattern: { username: 1 },
      }),
    );
    expect(page).toContain("That username is already taken.");
    expect(page).not.toContain("E11000");
  });

  test("a Mongoose validation error shows generic text, not its message", async () => {
    const err = new mongoose.Error.ValidationError();
    err.addError(
      "email",
      new mongoose.Error.ValidatorError({
        message: "Path `email` is invalid (x)",
      }),
    );
    const page = await signupFailingWith(err);
    expect(page).toContain("Please check the details you entered");
    expect(page).not.toContain("Path `email`");
  });

  test("an unexpected error is a 500 page, not a flash with its text", async () => {
    jest
      .spyOn(User, "register")
      .mockRejectedValue(new Error("connection refused 10.0.0.5:27017"));
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send(valid);
    expect(res.status).toBe(500);
    const next = await agent.get("/signup");
    expect(next.text).not.toContain("10.0.0.5");
  });
});

describe("login failure and account status", () => {
  test("unknown user or wrong password: one neutral message, not the library's", async () => {
    stubAuth(false, { message: "Password or username is incorrect" });
    const agent = createAgent();
    const res = await agent.post("/login").type("form").send(form);
    const page = await flashAfter(agent, res, "/login");
    expect(page).toContain("Incorrect username or password.");
    expect(page).not.toContain("Password or username is incorrect");
  });

  test.each([
    [
      "locked (too many attempts)",
      "Account locked due to too many failed login attempts",
    ],
    ["locked (too soon)", "Account is currently locked. Try again later"],
    ["missing credentials", "Missing credentials"],
  ])("%s shows the same neutral message", async (_label, libraryText) => {
    stubAuth(false, { message: libraryText });
    const agent = createAgent();
    const res = await agent.post("/login").type("form").send(form);
    const page = await flashAfter(agent, res, "/login");
    expect(page).toContain("Incorrect username or password.");
    expect(page).not.toContain(libraryText);
  });

  test("a suspended account cannot log in, and is not logged in", async () => {
    stubAuth(
      new User({
        username: "ann_01",
        email: "ann@example.com",
        status: "suspended",
      }),
    );
    const agent = createAgent();
    const res = await agent.post("/login").type("form").send(form);
    const page = await flashAfter(agent, res, "/login");
    expect(page).toContain("This account is suspended.");
    // still anonymous: a protected page sends the visitor to the login form
    const guarded = await agent.get("/listings/new");
    expect(guarded.status).toBe(302);
    expect(guarded.headers.location).toBe("/login");
  });

  test("a deleted account looks like an unknown one", async () => {
    stubAuth(
      new User({
        username: "ann_01",
        email: "ann@example.com",
        status: "deleted",
      }),
    );
    const agent = createAgent();
    const res = await agent.post("/login").type("form").send(form);
    const page = await flashAfter(agent, res, "/login");
    expect(page).toContain("Incorrect username or password.");
    expect(page).not.toMatch(/deleted|suspended/i);
  });

  test("an unexpected error in authentication is a 500 page", async () => {
    jest
      .spyOn(User, "authenticate")
      .mockReturnValue((u, p, done) => done(new Error("db exploded")));
    const res = await createAgent().post("/login").type("form").send(form);
    expect(res.status).toBe(500);
  });
});

describe("login success: new session and safe redirect", () => {
  const active = () =>
    new User({ username: "ann_01", email: "ann@example.com" });

  test("the session id changes at login (no session fixation)", async () => {
    stubAuth(active());
    const agent = createAgent();
    const before = sidOf(await agent.get("/login"));
    expect(before).toBeTruthy();
    const res = await agent.post("/login").type("form").send(form);
    expect(res.status).toBe(302);
    const after = sidOf(res);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  test("without a destination the user lands on /listings", async () => {
    stubAuth(active());
    const res = await createAgent().post("/login").type("form").send(form);
    expect(res.headers.location).toBe("/listings");
  });

  test.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "//evil.com/listings",
    "/login",
  ])("a `next` field of %j is ignored", async (next) => {
    stubAuth(active());
    const res = await createAgent()
      .post("/login")
      .type("form")
      .send({ ...form, next });
    expect(res.headers.location).toBe("/listings");
  });

  test("a local `next` path is used", async () => {
    stubAuth(active());
    const res = await createAgent()
      .post("/login")
      .type("form")
      .send({ ...form, next: "/listings/abc?x=1" });
    expect(res.headers.location).toBe("/listings/abc?x=1");
  });

  test("an unsafe `next` in the query string of the POST is ignored too", async () => {
    stubAuth(active());
    const res = await createAgent()
      .post("/login?next=//evil.com")
      .type("form")
      .send(form);
    expect(res.headers.location).toBe("/listings");
  });

  test("the page a visitor was stopped at is remembered through the login", async () => {
    stubAuth(active());
    const agent = createAgent();
    const stopped = await agent.get("/listings/new");
    expect(stopped.headers.location).toBe("/login");
    const res = await agent.post("/login").type("form").send(form);
    expect(res.headers.location).toBe("/listings/new");
  });

  test("a stored destination is used only once", async () => {
    stubAuth(active());
    const agent = createAgent();
    await agent.get("/listings/new");
    await agent.post("/login").type("form").send(form);
    const second = await createAgent().post("/login").type("form").send(form);
    expect(second.headers.location).toBe("/listings");
  });
});

describe("login form `next` field", () => {
  const hidden = (html) => html.match(/<input type="hidden" name="next"[^>]*>/);

  test("a safe `next` is carried in a hidden field", async () => {
    const res = await createAgent().get("/login?next=/listings/abc");
    expect(res.status).toBe(200);
    expect(hidden(res.text)[0]).toContain('value="/listings/abc"');
  });

  test.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:1"])(
    "an unsafe `next` (%j) is not put in the form",
    async (next) => {
      const res = await createAgent().get(
        `/login?next=${encodeURIComponent(next)}`,
      );
      expect(res.status).toBe(200);
      expect(hidden(res.text)).toBeNull();
    },
  );

  test("the value is HTML-escaped", async () => {
    const res = await createAgent().get(
      `/login?next=${encodeURIComponent('/x"onmouseover="alert(1)')}`,
    );
    expect(res.text).not.toContain('"onmouseover="alert(1)');
    expect(hidden(res.text)[0]).toContain("&#34;");
  });

  test("no `next` means no hidden field", async () => {
    const res = await createAgent().get("/login");
    expect(hidden(res.text)).toBeNull();
  });
});

describe("account lockout settings", () => {
  test("the model tracks attempts and the time of the last attempt", () => {
    const user = new User({ username: "ann_01", email: "ann@example.com" });
    expect(user.attempts).toBe(0);
    expect(User.schema.path("attempts")).toBeDefined();
    expect(User.schema.path("last")).toBeDefined();
  });

  test("an account with no stored `last` counts as 'no attempt yet', not 'just now'", () => {
    const user = new User({ username: "ann_01", email: "ann@example.com" });
    expect(user.last.getTime()).toBe(0);
  });

  test("limits are the documented ones", () => {
    expect(User.LOGIN_LIMITS).toEqual({
      MAX_ATTEMPTS: 10,
      UNLOCK_INTERVAL_MS: 15 * 60 * 1000,
      MAX_INTERVAL_MS: 5 * 60 * 1000,
    });
  });
});
