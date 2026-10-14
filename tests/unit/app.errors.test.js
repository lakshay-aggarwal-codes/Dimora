// P01-T04: behaviour of the real app (createApp) for errors and logging,
// without a database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");
const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/config/logger");
const { buildErrorApp, listen } = require("../helpers/errorApp");
const { memoryLog } = require("../helpers/logCapture");

const CONFIG = {
  port: 0,
  isProduction: false,
  mongodbUri: "mongodb://127.0.0.1:1/never-connected",
  sessionSecret: "test-session-secret-not-for-production",
  cloudinary: { cloudName: "c", apiKey: "k", apiSecret: "s" },
  mapbox: { serverToken: "pk.server", publicToken: "pk.public" },
};

async function withApp(overrides, fn) {
  const app = createApp({
    config: { ...CONFIG, ...overrides.config },
    sessionStore: new session.MemoryStore(),
    logger: overrides.logger || createLogger({ level: "silent" }),
  });
  const { base, close } = await listen(app);
  try {
    return await fn(base);
  } finally {
    await close();
  }
}

test("a malformed listing id is a 404 page, not a 500 with driver text", async () => {
  await withApp({ config: { isProduction: true } }, async (base) => {
    const res = await fetch(`${base}/listings/not-an-object-id`);
    const html = await res.text();
    assert.equal(res.status, 404);
    assert.match(html, /Page Not Found/);
    assert.match(html, /navbar/);
    assert.ok(!/Cast to ObjectId|ObjectId failed|CastError/.test(html));
  });
});

test("an unknown route is the 404 page with a request id header and the navbar", async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/definitely/not/here`);
    const html = await res.text();
    assert.equal(res.status, 404);
    assert.match(html, /404 &middot; Page Not Found/);
    assert.match(html, /navbar/);
    const id = res.headers.get("x-request-id");
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.ok(html.includes(id), "the page shows the same reference id");
  });
});

test("an unknown /api route answers JSON", async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/api/nothing`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.status, 404);
    assert.equal(body.error.code, "not_found");
  });
});

test("request logs carry id/method/path/status and never cookies, auth headers or query strings", async () => {
  const log = memoryLog();
  await withApp({ logger: log.logger }, async (base) => {
    await fetch(`${base}/missing?token=QUERYSECRET`, {
      headers: {
        Cookie: "connect.sid=COOKIESECRET",
        Authorization: "Bearer AUTHSECRET",
      },
    });
  });
  const text = log.text();
  for (const secret of ["COOKIESECRET", "AUTHSECRET", "QUERYSECRET"]) {
    assert.ok(!text.includes(secret), `${secret} was logged`);
  }
  const record = log
    .records()
    .find((r) => r.req && r.req.url === "/missing" && r.res);
  assert.ok(record, "a request log line exists");
  assert.equal(record.res.statusCode, 404);
  assert.match(record.req.id, /^[0-9a-f-]{36}$/);
  assert.equal(record.req.method, "GET");
});

test("the logger redacts password, hash and salt wherever they appear", () => {
  const log = memoryLog();
  log.logger.info(
    {
      password: "plain-pw",
      user: {
        username: "ann",
        hash: "HASHVALUE",
        salt: "SALTVALUE",
        password: "pw2",
      },
      req: {
        headers: {
          cookie: "c=COOKIEVALUE",
          authorization: "Bearer TOKENVALUE",
        },
        body: { password: "BODYPW" },
      },
      err: { keyValue: { email: "ann@example.com" } },
    },
    "probe",
  );
  const text = log.text();
  for (const secret of [
    "plain-pw",
    "HASHVALUE",
    "SALTVALUE",
    "pw2",
    "COOKIEVALUE",
    "TOKENVALUE",
    "BODYPW",
    "ann@example.com",
  ]) {
    assert.ok(!text.includes(secret), `${secret} was logged`);
  }
  assert.ok(text.includes("ann"), "non-sensitive fields still logged");
});

test("a 5xx is logged with its stack server-side but not shown to the visitor", async () => {
  const log = memoryLog();
  const app = buildErrorApp({
    isProduction: true,
    logger: log.logger,
    routes: (a) =>
      a.get("/boom", () => {
        throw new Error("internal detail XYZ");
      }),
  });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/boom`);
    assert.ok(!(await res.text()).includes("internal detail XYZ"));
  } finally {
    await close();
  }
  const rec = log.records().find((r) => r.msg === "request failed");
  assert.ok(rec, "the failure was logged");
  assert.equal(rec.level, 50);
  assert.match(rec.err.message, /internal detail XYZ/);
  assert.ok(rec.err.stack);
});

test("controllers no longer print user documents to the console", () => {
  const dir = path.join(__dirname, "..", "..", "src", "controllers");
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/console\.log\(/.test(src), `${file} still calls console.log`);
  }
});
