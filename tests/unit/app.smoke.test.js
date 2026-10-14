// P01-T03: the app is importable and runs without a database or a fixed port.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const session = require("express-session");
const mongoose = require("mongoose");
const { createLogger } = require("../../src/config/logger");

const ROOT = path.join(__dirname, "..", "..");

const CONFIG = Object.freeze({
  port: 0,
  mongodbUri: "mongodb://127.0.0.1:1/never-connected",
  sessionSecret: "test-session-secret-not-for-production",
  cloudinary: { cloudName: "c", apiKey: "k", apiSecret: "s" },
  mapbox: { serverToken: "pk.server", publicToken: "pk.public" },
});

async function withServer(fn) {
  const { createApp } = require("../../src/app");
  const app = createApp({
    config: CONFIG,
    sessionStore: new session.MemoryStore(),
    logger: createLogger({ level: "silent" }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requiring src/app has no side effects (no env needed, nothing listens or connects)", () => {
  // A clean child process with an empty environment: if requiring the module
  // read the env, opened a connection or started a server, this would throw
  // or hang until the timeout.
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      'const m = require("./src/app"); console.log(typeof m.createApp, require("mongoose").connection.readyState);',
    ],
    { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 15000 },
  )
    .toString()
    .trim();
  assert.equal(out, "function 0");
});

test("createApp() serves the 404 page for an unknown route without a database", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/no/such/route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /Page Not Found/);
  });
  assert.equal(mongoose.connection.readyState, 0);
});

test("views and static files resolve after the move into src/", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/login`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form/i);

    const css = await fetch(`${base}/css/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
  });
});

test("createApp() can be called more than once (each call is an independent app)", () => {
  const { createApp } = require("../../src/app");
  const make = () =>
    createApp({
      config: CONFIG,
      sessionStore: new session.MemoryStore(),
      logger: createLogger({ level: "silent" }),
    });
  assert.notEqual(make(), make());
});
