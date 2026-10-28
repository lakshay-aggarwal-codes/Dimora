// Post-deploy smoke test (P19-T03):
//
//   npm run smoke:deploy -- https://your-service.onrender.com
//
// Wakes a sleeping free instance (polls /healthz for up to two minutes), then
// checks readiness, a few public pages, and the headers a production site must
// send. Read-only: it only sends GET requests and never logs in. Exit code 1
// when any check fails. Needs Node 20+ (built-in fetch).

const WAKE_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {number} [options.wakeTimeoutMs]
 * @param {number} [options.pollMs]
 * @returns {Promise<{ ok: boolean, results: {name: string, ok: boolean, detail: string}[] }>}
 */
async function runSmoke({
  baseUrl,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  wakeTimeoutMs = WAKE_TIMEOUT_MS,
  pollMs = POLL_MS,
}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(base)) {
    throw new Error("Give the site address, e.g. https://your-service.onrender.com");
  }
  const isHttps = base.startsWith("https://");
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  const get = (path) =>
    fetchImpl(base + path, {
      redirect: "manual",
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  // 1. Wake the instance and time it.
  const started = now();
  let awake = false;
  let lastProblem = "no answer";
  while (now() - started < wakeTimeoutMs) {
    try {
      const res = await get("/healthz");
      if (res.status === 200) {
        awake = true;
        break;
      }
      lastProblem = `status ${res.status}`;
    } catch (err) {
      lastProblem = err && err.name === "TimeoutError" ? "timed out" : "no connection";
    }
    await sleep(pollMs);
  }
  const wakeSeconds = Math.round((now() - started) / 1000);
  add(
    "/healthz answers 200",
    awake,
    awake ? `after ${wakeSeconds} s (a long wait is a cold start)` : `gave up after ${wakeSeconds} s: ${lastProblem}`,
  );
  if (!awake) return { ok: false, results };

  const check = async (name, path, test) => {
    try {
      const res = await get(path);
      const detail = test(res);
      add(name, detail === true, detail === true ? `status ${res.status}` : detail);
    } catch (err) {
      add(name, false, err && err.name === "TimeoutError" ? "timed out" : "request failed");
    }
  };
  const status = (want) => (res) => res.status === want || `status ${res.status}, expected ${want}`;

  await check("/readyz: database connected", "/readyz", status(200));
  await check("home page", "/", status(200));
  await check("/listings", "/listings", status(200));
  await check("login page", "/login", status(200));
  // The admin area must look like any other missing page to a visitor.
  await check("/admin is hidden from visitors", "/admin", status(404));
  await check("unknown page is a plain 404", "/no-such-page-xyz", (res) =>
    res.status === 404 || `status ${res.status}, expected 404`,
  );

  await check("security headers", "/", (res) => {
    const h = res.headers;
    if (h.get("x-powered-by")) return "X-Powered-By is sent";
    if (!h.get("content-security-policy")) return "no Content-Security-Policy";
    if (!h.get("x-content-type-options")) return "no X-Content-Type-Options";
    if (isHttps && !h.get("strict-transport-security")) return "no Strict-Transport-Security";
    return true;
  });

  await check("session cookie flags", "/login", (res) => {
    const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const session = cookies.find((c) => /^connect\.sid=/.test(c));
    if (!session) return true; // no session cookie on this page: nothing to check
    if (!/;\s*HttpOnly/i.test(session)) return "session cookie is not HttpOnly";
    if (isHttps && !/;\s*Secure/i.test(session)) return "session cookie is not Secure";
    return true;
  });

  return { ok: results.every((r) => r.ok), results };
}

async function main() {
  const baseUrl = process.argv[2] || process.env.SMOKE_URL;
  if (!baseUrl) {
    console.error("Usage: npm run smoke:deploy -- https://your-service.onrender.com");
    process.exit(2);
  }
  const { ok, results } = await runSmoke({ baseUrl });
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name} (${r.detail})`);
  console.log(ok ? "Smoke test passed." : "Smoke test FAILED.");
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { runSmoke };
