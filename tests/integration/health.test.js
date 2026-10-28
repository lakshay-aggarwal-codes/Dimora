// P19-T03: /healthz and /readyz.
const assert = require("node:assert/strict");
const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/config/logger");
const { testConfig } = require("../helpers/config");

function appWith({ isDbReady, config = testConfig() } = {}) {
  const lines = [];
  const logger = createLogger({ level: "info", destination: { write: (l) => lines.push(l) } });
  const store = new session.MemoryStore();
  const app = createApp({ config, sessionStore: store, logger, isDbReady });
  return { app, lines, store };
}

test("/healthz answers 200 without touching the database", async () => {
  let asked = 0;
  const { app } = appWith({ isDbReady: () => (asked += 1, false) });
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.equal(asked, 0);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("/healthz sets no session cookie and needs no CSRF token", async () => {
  const { app, store } = appWith({ isDbReady: () => false });
  const res = await request(app).get("/healthz");
  assert.equal(res.headers["set-cookie"], undefined);
  const sessions = await new Promise((r) => store.all((e, all) => r(all)));
  assert.equal(Object.keys(sessions || {}).length, 0);
});

test("health checks are not written to the request log", async () => {
  const { app, lines } = appWith({ isDbReady: () => true });
  await request(app).get("/healthz");
  await request(app).get("/readyz");
  assert.equal(lines.join("").includes("healthz"), false);
  assert.equal(lines.join("").includes("readyz"), false);
});

test("/readyz is 200 while the database is up and 503 when it is not", async () => {
  const up = appWith({ isDbReady: () => true });
  const ok = await request(up.app).get("/readyz");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { status: "ready" });

  const down = appWith({ isDbReady: async () => false });
  const bad = await request(down.app).get("/readyz");
  assert.equal(bad.status, 503);
  assert.deepEqual(bad.body, { status: "unavailable" });
});

test("/readyz is 503, not a crash, when the check itself throws", async () => {
  const { app } = appWith({
    isDbReady: () => {
      throw new Error("mongodb://user:secret@host exploded");
    },
  });
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
  assert.equal(JSON.stringify(res.body).includes("secret"), false);
});

test("default readiness follows the Mongoose connection state", async () => {
  // No connection was opened in this test process: readyState is 0.
  const { app } = appWith();
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
});

test("HEAD works, other methods get 405 with Allow, and no body leaks details", async () => {
  const { app } = appWith({ isDbReady: () => true });
  const head = await request(app).head("/healthz");
  assert.equal(head.status, 200);
  const post = await request(app).post("/healthz");
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  const del = await request(app).delete("/readyz");
  assert.equal(del.status, 405);
});

test("the answer carries the security headers and nothing about the build", async () => {
  const { app } = appWith({ isDbReady: () => true });
  const res = await request(app).get("/healthz");
  assert.ok(res.headers["content-security-policy"]);
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.deepEqual(Object.keys(res.body), ["status"]);
});

test("a path that only starts with /healthz is not a health check", async () => {
  const { app } = appWith({ isDbReady: () => true });
  const res = await request(app).get("/healthz/extra");
  assert.equal(res.status, 404);
});

test("TRUST_PROXY_HOPS sets how many proxies Express trusts in production", () => {
  const prod = (hops) =>
    testConfig({ isProduction: true, isTest: false, env: "production", trustProxyHops: hops });
  assert.equal(appWith({ config: prod(3) }).app.get("trust proxy"), 3);
  assert.equal(appWith({ config: prod(undefined) }).app.get("trust proxy"), 1);
  // Outside production nothing is trusted (a developer's machine has no proxy).
  assert.equal(appWith({ config: testConfig({ trustProxyHops: 3 }) }).app.get("trust proxy"), false);
});
