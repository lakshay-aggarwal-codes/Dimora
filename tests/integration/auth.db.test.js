// Needs a MongoDB (mongodb-memory-server downloads one on first run).
// Skip with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { memoryLog } = require("../helpers/logCapture");
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");

describeDb("database harness and auth flows", () => {
  useTestDb();

  test("factories save documents and collections are wiped between tests", async () => {
    const listing = await createListing({ title: "Harness listing" });
    expect(await Listing.countDocuments()).toBe(1);
    expect(String(listing.owner)).toBeTruthy();
  });

  test("the previous test's data is gone", async () => {
    expect(await Listing.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(0);
  });

  test("GET /listings shows a listing saved in the database", async () => {
    await createListing({ title: "Visible in the index" });
    const res = await createAgent().get("/listings");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Visible in the index");
  });

  test("signup stores a hashed password and logs the user in", async () => {
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send({
      username: "ann",
      email: "ann@example.com",
      password: "s3cret-pass-phrase",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/listings");

    const stored = await User.findOne({ username: "ann" }).select(
      "+hash +salt",
    );
    expect(stored).not.toBeNull();
    expect(stored.hash).toBeTruthy();
    expect(stored.hash).not.toContain("s3cret-pass-phrase");

    // logged in: the create-listing form is reachable
    expect((await agent.get("/listings/new")).status).toBe(200);
  });

  test("regression (P01-T04): signup does not print or log the hash, salt or password", async () => {
    const log = memoryLog();
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    const agent = createAgent({ logger: log.logger });
    await agent.post("/signup").type("form").send({
      username: "bob",
      email: "bob@example.com",
      password: "another-pass-phrase",
    });

    const stored = await User.findOne({ username: "bob" }).select(
      "+hash +salt",
    );
    expect(stored.hash).toBeTruthy();
    const printed = consoleLog.mock.calls
      .map((args) => JSON.stringify(args))
      .join("");
    for (const secret of [stored.hash, stored.salt, "another-pass-phrase"]) {
      expect(log.text()).not.toContain(secret);
      expect(printed).not.toContain(secret);
    }
    consoleLog.mockRestore();
  });

  test("signing up with a taken username goes back to the form with a message", async () => {
    await createUser({ username: "taken" });
    const res = await createAgent().post("/signup").type("form").send({
      username: "taken",
      email: "x@example.com",
      password: "whatever-pass",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/signup");
  });

  test("login helper signs in through the real form; a wrong password does not", async () => {
    const { user, password } = await createUser();
    const agent = await login(createAgent(), {
      username: user.username,
      password,
    });
    expect((await agent.get("/listings/new")).status).toBe(200);

    const bad = await createAgent()
      .post("/login")
      .type("form")
      .send({ username: user.username, password: "wrong-password" });
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe("/login");
  });

  test("a malformed listing id is still a 404 page with the database connected", async () => {
    const res = await createAgent().get("/listings/abc");
    expect(res.status).toBe(404);
  });
});
