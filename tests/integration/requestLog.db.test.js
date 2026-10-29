// P17-T05 through the real app: what a request leaves in the log. Needs a
// MongoDB (the password and email routes read it); skipped with SKIP_DB_TESTS=1.
const assert = require("node:assert/strict");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser } = require("../helpers/factories");
const { memoryLog } = require("../helpers/logCapture");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDe";
const SECRET = "Pa55-word-never-in-logs";

describeDb("request logging (database)", () => {
  useTestDb();

  test("one-time tokens in the path are not logged", async () => {
    const log = memoryLog();
    const agent = createAgent({ logger: log.logger });
    await agent.get(`/reset-password/${TOKEN}`);
    await agent.get(`/verify-email/${TOKEN}`);
    const text = log.text();
    assert.ok(text.includes("/reset-password/[redacted]"));
    assert.ok(text.includes("/verify-email/[redacted]"));
    assert.equal(text.includes(TOKEN), false);
  });

  test("query strings, form bodies, cookies and CSRF tokens are not logged", async () => {
    const log = memoryLog();
    const agent = createAgent({ logger: log.logger });
    const { user } = await createUser();
    await agent.get("/listings?q=secret-search-term");
    await agent.post("/login").type("form").send({ username: user.username, password: SECRET });
    await agent.post("/forgot-password").type("form").send({ email: "someone@example.com" });
    const text = log.text();
    for (const needle of [SECRET, "secret-search-term", "someone@example.com", "connect.sid"]) {
      assert.equal(text.includes(needle), false, needle);
    }
    const first = log.records().find((r) => r.req);
    assert.deepEqual(Object.keys(first.req).sort(), ["id", "method", "url"]);
  });
});
