// P02-T02 against a real MongoDB (mongodb-memory-server or TEST_MONGODB_URI).
// Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser } = require("../helpers/factories");
const User = require("../../src/models/user");

const { MAX_ATTEMPTS, UNLOCK_INTERVAL_MS } = User.LOGIN_LIMITS;

const rawUsers = () => mongoose.connection.db.collection("users");
const attemptLogin = (agent, username, password) =>
  agent.post("/login").type("form").send({ username, password });
const isLoggedIn = async (agent) =>
  (await agent.get("/listings/new")).status === 200;

describeDb("login hardening (database)", () => {
  useTestDb();

  test("signup with a valid form creates a member, hashes the password, logs in", async () => {
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send({
      username: "dana_9",
      email: "Dana@Example.com",
      password: "a-long-pass-phrase",
      role: "admin",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/listings");
    const stored = await User.findOne({ username: "dana_9" }).select(
      "+hash +salt",
    );
    expect(stored.role).toBe("member");
    expect(stored.email).toBe("dana@example.com");
    expect(stored.hash).toBeTruthy();
    expect(stored.hash).not.toContain("a-long-pass-phrase");
    expect(await isLoggedIn(agent)).toBe(true);
  });

  test("a weak password creates no account", async () => {
    const res = await createAgent().post("/signup").type("form").send({
      username: "weak_1",
      email: "weak@example.com",
      password: "Password123",
    });
    expect(res.headers.location).toBe("/signup");
    expect(await User.countDocuments()).toBe(0);
  });

  test("a suspended user with the correct password is refused", async () => {
    const { user, password } = await createUser();
    await User.updateOne({ _id: user._id }, { status: "suspended" });
    const agent = createAgent();
    const res = await attemptLogin(agent, user.username, password);
    expect(res.headers.location).toBe("/login");
    expect((await agent.get("/login")).text).toContain(
      "This account is suspended.",
    );
    expect(await isLoggedIn(agent)).toBe(false);
  });

  test("a deleted user is refused with the neutral message", async () => {
    const { user, password } = await createUser();
    await User.updateOne({ _id: user._id }, { status: "deleted" });
    const agent = createAgent();
    await attemptLogin(agent, user.username, password);
    const page = await agent.get("/login");
    expect(page.text).toContain("Incorrect username or password.");
    expect(await isLoggedIn(agent)).toBe(false);
  });

  test("a wrong password and an unknown user give the same message", async () => {
    const { user } = await createUser();
    const a = createAgent();
    await attemptLogin(a, user.username, "wrong-password-1");
    const b = createAgent();
    await attemptLogin(b, "nobody_here", "wrong-password-1");
    const textA = (await a.get("/login")).text.match(
      /Incorrect username[^<]*/,
    )[0];
    const textB = (await b.get("/login")).text.match(
      /Incorrect username[^<]*/,
    )[0];
    expect(textA).toBe(textB);
  });

  test("a failed attempt is counted; a correct login resets the counter", async () => {
    const { user, password } = await createUser();
    await attemptLogin(createAgent(), user.username, "wrong-password-1");
    expect((await User.findById(user._id)).attempts).toBe(1);

    // the next attempt must wait out the short back-off after a failure
    await new Promise((resolve) => setTimeout(resolve, 150));
    const agent = createAgent();
    const res = await attemptLogin(agent, user.username, password);
    expect(res.headers.location).toBe("/listings");
    expect((await User.findById(user._id)).attempts).toBe(0);
  });

  test(`after ${MAX_ATTEMPTS} failures even the correct password is refused`, async () => {
    const { user, password } = await createUser();
    await User.updateOne(
      { _id: user._id },
      { attempts: MAX_ATTEMPTS, last: new Date() },
    );
    const agent = createAgent();
    const res = await attemptLogin(agent, user.username, password);
    expect(res.headers.location).toBe("/login");
    expect((await agent.get("/login")).text).toContain(
      "Incorrect username or password.",
    );
    expect(await isLoggedIn(agent)).toBe(false);
  });

  test("the lock ends after the unlock interval and the counter resets", async () => {
    const { user, password } = await createUser();
    await User.updateOne(
      { _id: user._id },
      {
        attempts: MAX_ATTEMPTS,
        last: new Date(Date.now() - UNLOCK_INTERVAL_MS - 60000),
      },
    );
    const agent = createAgent();
    const res = await attemptLogin(agent, user.username, password);
    expect(res.headers.location).toBe("/listings");
    expect(await isLoggedIn(agent)).toBe(true);
    expect((await User.findById(user._id)).attempts).toBe(0);
  });

  test("an account with no attempts/last fields (created before this task) can log in", async () => {
    const { user, password } = await createUser();
    await rawUsers().updateOne(
      { _id: user._id },
      { $unset: { attempts: 1, last: 1 } },
    );
    const agent = createAgent();
    const res = await attemptLogin(agent, user.username, password);
    expect(res.headers.location).toBe("/listings");
    expect(await isLoggedIn(agent)).toBe(true);
  });

  test("the `login` helper still works for a normal user (hash/salt never in the page)", async () => {
    const { user, password } = await createUser();
    const agent = await login(createAgent(), {
      username: user.username,
      password,
    });
    expect(await isLoggedIn(agent)).toBe(true);
  });

  test("open-redirect payloads after a real login fall back to /listings", async () => {
    const { user, password } = await createUser();
    for (const next of ["//evil.com", "https://evil.com", "/\\evil.com"]) {
      const res = await createAgent()
        .post("/login")
        .type("form")
        .send({ username: user.username, password, next });
      expect(res.headers.location).toBe("/listings");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
});
