// P01-T09: successful logins are not counted by the login rate limit.
// Needs a MongoDB (see tests/helpers/db.js).
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser } = require("../helpers/factories");

describeDb("login rate limit (database)", () => {
  useTestDb();

  test("seven successful logins in a row are all accepted", async () => {
    const { user, password } = await createUser();
    const agent = createAgent();
    for (let i = 0; i < 7; i += 1) {
      const res = await agent
        .post("/login")
        .type("form")
        .send({ username: user.username, password });
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toBe("/login");
    }
  });

  test("five wrong passwords block the sixth attempt, even with the right password", async () => {
    const { user, password } = await createUser();
    const agent = createAgent();
    for (let i = 0; i < 5; i += 1) {
      const res = await agent
        .post("/login")
        .type("form")
        .send({ username: user.username, password: "wrong" });
      expect(res.headers.location).toBe("/login");
    }
    const res = await agent
      .post("/login")
      .type("form")
      .send({ username: user.username, password });
    expect(res.status).toBe(429);
  });
});
