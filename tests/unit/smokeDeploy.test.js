// P19-T03: scripts/smoke-deploy.js with a fake fetch.
const assert = require("node:assert/strict");
const { runSmoke } = require("../../scripts/smoke-deploy");

const GOOD_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=15552000",
};

function reply(status, headers = {}, cookies = []) {
  const h = new Headers(headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response("", { status, headers: h });
}

// A healthy production site, with per-path overrides.
function site(overrides = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path](url);
    if (path === "/admin" || path === "/no-such-page-xyz") return reply(404, GOOD_HEADERS);
    return reply(200, GOOD_HEADERS);
  };
}

const fast = { sleep: async () => {}, pollMs: 1 };

test("a healthy site passes every check", async () => {
  const out = await runSmoke({ baseUrl: "https://dimora.example.com/", fetchImpl: site(), ...fast });
  assert.equal(out.ok, true, JSON.stringify(out.results.filter((r) => !r.ok)));
  assert.ok(out.results.length >= 8);
});

test("waits for a sleeping instance, then goes on", async () => {
  let healthCalls = 0;
  const fetchImpl = site({
    "/healthz": () => (++healthCalls < 3 ? reply(502) : reply(200, GOOD_HEADERS)),
  });
  const out = await runSmoke({ baseUrl: "https://x.example.com", fetchImpl, ...fast });
  assert.equal(healthCalls, 3);
  assert.equal(out.ok, true);
});

test("an instance that never wakes fails after the timeout and runs no other check", async () => {
  let t = 0;
  const out = await runSmoke({
    baseUrl: "https://x.example.com",
    fetchImpl: async () => reply(503),
    sleep: async () => {},
    now: () => (t += 50_000),
    wakeTimeoutMs: 120_000,
    pollMs: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.results.length, 1);
  assert.match(out.results[0].detail, /gave up/);
});

test("a connection error while waking is retried, not thrown", async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/healthz" && ++n < 2) throw new TypeError("fetch failed");
    return site()(url);
  };
  const out = await runSmoke({ baseUrl: "https://x.example.com", fetchImpl, ...fast });
  assert.equal(out.ok, true);
});

test("readiness 503 (database down) fails the run", async () => {
  const out = await runSmoke({
    baseUrl: "https://x.example.com",
    fetchImpl: site({ "/readyz": () => reply(503, GOOD_HEADERS) }),
    ...fast,
  });
  assert.equal(out.ok, false);
  assert.equal(out.results.find((r) => r.name.startsWith("/readyz")).ok, false);
});

test("an admin page that answers 200 or 403 to a visitor fails", async () => {
  for (const status of [200, 302, 403]) {
    const out = await runSmoke({
      baseUrl: "https://x.example.com",
      fetchImpl: site({ "/admin": () => reply(status, GOOD_HEADERS) }),
      ...fast,
    });
    assert.equal(out.results.find((r) => r.name.includes("/admin")).ok, false, `status ${status}`);
  }
});

test("missing security headers are reported", async () => {
  const bare = (url) => reply(new URL(url).pathname === "/" ? 200 : 200, { "x-powered-by": "Express" });
  const out = await runSmoke({ baseUrl: "https://x.example.com", fetchImpl: bare, ...fast });
  const row = out.results.find((r) => r.name === "security headers");
  assert.equal(row.ok, false);
  assert.match(row.detail, /X-Powered-By/);
});

test("HSTS is only required over https", async () => {
  const noHsts = { "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff" };
  const fetchImpl = async (url) => {
    const p = new URL(url).pathname;
    return reply(p === "/admin" || p === "/no-such-page-xyz" ? 404 : 200, noHsts);
  };
  const http = await runSmoke({ baseUrl: "http://localhost:8080", fetchImpl, ...fast });
  assert.equal(http.results.find((r) => r.name === "security headers").ok, true);
  const https = await runSmoke({ baseUrl: "https://x.example.com", fetchImpl, ...fast });
  assert.equal(https.results.find((r) => r.name === "security headers").ok, false);
});

test("a session cookie without Secure or HttpOnly over https fails", async () => {
  const withCookie = (cookie) =>
    site({ "/login": () => reply(200, GOOD_HEADERS, [cookie]) });
  const weak = await runSmoke({
    baseUrl: "https://x.example.com",
    fetchImpl: withCookie("connect.sid=abc; Path=/; HttpOnly"),
    ...fast,
  });
  assert.equal(weak.results.find((r) => r.name === "session cookie flags").ok, false);
  const strong = await runSmoke({
    baseUrl: "https://x.example.com",
    fetchImpl: withCookie("connect.sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax"),
    ...fast,
  });
  assert.equal(strong.results.find((r) => r.name === "session cookie flags").ok, true);
});

test("only GET requests are sent", async () => {
  const methods = new Set();
  const fetchImpl = async (url, init) => {
    methods.add((init && init.method) || "GET");
    return site()(url);
  };
  await runSmoke({ baseUrl: "https://x.example.com", fetchImpl, ...fast });
  assert.deepEqual([...methods], ["GET"]);
});

test("an address that is not http(s) is refused", async () => {
  await assert.rejects(() => runSmoke({ baseUrl: "dimora.example.com" }), /site address/);
  await assert.rejects(() => runSmoke({ baseUrl: "" }), /site address/);
});
