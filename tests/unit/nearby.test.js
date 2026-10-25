// P15-T01: nearby places. The Overpass server is a fake `fetch`; the answers
// below are written by hand in the shape Overpass returns (`out center tags`),
// they were NOT recorded from the live service. No network, no database.
const fs = require("node:fs");
const path = require("node:path");
const nearby = require("../../src/services/nearby");
const { runRetryPass } = require("../../src/services/nearbyRetry");
const { CATEGORIES, RULES, readNearbyConfig } = require("../../src/config/nearby");
const { distanceMeters } = require("../../src/utils/geo");

const NOW = new Date("2026-10-25T06:00:00Z");
const at = (ms) => {
  const d = new Date();
  d.setTime(NOW.getTime() + ms);
  return d;
};
const HOUR = 3600 * 1000;

const config = readNearbyConfig({ NEARBY_ENABLED: "true", NEARBY_CONTACT: "ops@dimora.test" });
const PRECISE = { lng: 73.8278, lat: 15.4989 };
const PUBLIC = { lng: 73.8318, lat: 15.4989 }; // about 430 m east of the precise point

function listing(extra = {}) {
  return {
    _id: "6720a0000000000000000001",
    status: "published",
    geometry: { type: "Point", coordinates: [PRECISE.lng, PRECISE.lat] },
    publicGeometry: { type: "Point", coordinates: [PUBLIC.lng, PUBLIC.lat] },
    ...extra,
  };
}

// An Overpass element `metres` east of the PUBLIC point.
const node = (name, metres, tags = {}) => ({
  type: "node",
  id: Math.floor(Math.random() * 1e9),
  lat: PUBLIC.lat,
  lon: PUBLIC.lng + metres / 111000 / Math.cos((PUBLIC.lat * Math.PI) / 180),
  tags: { ...(name ? { name } : {}), amenity: "restaurant", ...tags },
});

const reply = (elements, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => (Array.isArray(elements) || !elements ? { elements: elements || [] } : elements),
});

/** A fake Overpass: `answer(categoryId, call)` returns a reply or throws. */
function overpass(answer) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setImmediate(r));
      const query = new URLSearchParams(init.body).get("data");
      const category = CATEGORIES.find((c) => c.selectors.every((s) => query.includes(s)));
      const call = { url, init, query, category: category.id };
      calls.push(call);
      return answer(category.id, call, calls.length);
    } finally {
      inFlight--;
    }
  };
  return { fetch: fetchFn, calls, maxInFlight: () => maxInFlight };
}

function store() {
  const updates = [];
  return {
    updates,
    Listing: { updateOne: async (filter, update) => updates.push({ filter, update }) },
  };
}
const sleeps = [];
const sleep = async (ms) => sleeps.push(ms);
const run = (doc, server, db, extra = {}) =>
  nearby.refreshListing(doc, {
    now: NOW,
    deps: { config, fetch: server.fetch, sleep, Listing: db.Listing, ...extra },
    ...(extra.options || {}),
  });
const fails = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
};

describe("distance (haversine) golden values", () => {
  test("one degree of longitude on the equator, and London to Paris", () => {
    const equator = distanceMeters({ lng: 0, lat: 0 }, { lng: 1, lat: 0 });
    expect(Math.abs(equator - 111195) < 100).toBe(true);
    const lonPar = distanceMeters({ lng: -0.1278, lat: 51.5074 }, { lng: 2.3522, lat: 48.8566 });
    expect(Math.abs(lonPar - 343600) < 1500).toBe(true);
    expect(distanceMeters(PRECISE, PRECISE)).toBe(0);
  });
});

describe("cleanName and parseElements", () => {
  test("names are plain one-line text: control and bidi characters go, HTML stays as text, 100 characters at most", () => {
    expect(nearby.cleanName("  Cafe\u0000  \u202Eevil\n name ")).toBe("Cafe evil name");
    expect(nearby.cleanName("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(nearby.cleanName("x".repeat(300)).length).toBe(100);
    expect(nearby.cleanName("   ")).toBe(null);
    expect(nearby.cleanName(42)).toBe(null);
  });

  test("takes nodes and ways, measures from the origin, rounds to 10 m, nearest first, one per name, top 5", () => {
    const category = CATEGORIES.find((c) => c.id === "food");
    const elements = [
      node("Far Cafe", 900),
      node("Near Cafe", 120),
      { type: "way", id: 1, center: { lat: PUBLIC.lat, lon: PUBLIC.lng }, tags: { name: "Way Diner", amenity: "cafe" } },
      node("near cafe", 480), // same name (case differs): only the nearest stays
      node(null, 200, { amenity: "fast_food" }),
      node("Five", 300),
      node("Six", 310),
      node("Seven", 320),
      { type: "node", id: 9, tags: { name: "No position" } }, // skipped
    ];
    const items = nearby.parseElements(elements, category, PUBLIC);
    expect(items.length).toBe(5);
    expect(items.map((i) => i.name)).toEqual(["Way Diner", "Near Cafe", null, "Five", "Six"]);
    expect(items[0].distanceM).toBe(0);
    expect(items[1].distanceM % 10).toBe(0);
    expect(Math.abs(items[1].distanceM - 120) <= 10).toBe(true);
    expect(items[2].kind).toBe("fast_food");
  });
});

describe("buildQuery", () => {
  test("centres on the precise point and declares timeout and size", () => {
    const category = CATEGORIES.find((c) => c.id === "pharmacy");
    const query = nearby.buildQuery(PRECISE, category);
    expect(query.includes("around:2000,15.498900,73.827800")).toBe(true);
    expect(query.includes("[timeout:20]")).toBe(true);
    expect(query.includes("[maxsize:")).toBe(true);
    expect(query.includes('nwr["amenity"="pharmacy"]')).toBe(true);
    expect(query.includes("out center tags 300;")).toBe(true);
    expect(query.includes("73.831800")).toBe(false); // never the public point
  });
});

describe("refreshListing: success", () => {
  test("7 polite requests, one at a time, stored without the precise point", async () => {
    const server = overpass((id) => reply(id === "food" ? [node("Near Cafe", 120)] : []));
    const db = store();
    const result = await run(listing(), server, db);
    expect(result).toEqual({ status: "updated", count: 1 });
    expect(server.calls.length).toBe(CATEGORIES.length);
    expect(server.maxInFlight()).toBe(1);
    const sent = server.calls[0].init;
    expect(sent.method).toBe("POST");
    expect(sent.headers["User-Agent"].includes("ops@dimora.test")).toBe(true);
    expect(sent.headers["User-Agent"].startsWith("Dimora-nearby/")).toBe(true);

    expect(db.updates.length).toBe(1);
    const stored = db.updates[0].update.$set.nearby;
    expect(stored.source).toBe("OpenStreetMap contributors");
    expect(stored.fetchedAt).toBe(NOW);
    expect(stored.items.length).toBe(1);
    expect(stored.failures).toBe(0);
    expect(stored.nextRetryAt).toBe(null);
    const text = JSON.stringify(db.updates[0].update);
    expect(text.includes("73.8278")).toBe(false);
    expect(text.includes("15.4989")).toBe(false);
  });

  test("a rural listing with nothing around still succeeds with an empty list", async () => {
    const server = overpass(() => reply([]));
    const db = store();
    expect(await run(listing(), server, db)).toEqual({ status: "updated", count: 0 });
    expect(db.updates[0].update.$set.nearby.items).toEqual([]);
  });

  test("two refreshes started together never overlap (global concurrency 1)", async () => {
    const server = overpass(() => reply([]));
    const db = store();
    await Promise.all([
      run(listing({ _id: "6720a0000000000000000001" }), server, db),
      run(listing({ _id: "6720a0000000000000000002" }), server, db),
    ]);
    expect(server.calls.length).toBe(CATEGORIES.length * 2);
    expect(server.maxInFlight()).toBe(1);
  });
});

describe("refreshListing: failures never break publishing and never erase data", () => {
  test("a server error is retried once, then recorded; earlier data stays", async () => {
    sleeps.length = 0;
    const server = overpass(() => reply(null, 503));
    const db = store();
    const earlier = { fetchedAt: at(-30 * 24 * HOUR), key: "other", failures: 0 };
    const result = await run(listing({ nearby: earlier }), server, db);
    expect(result.status).toBe("failed");
    expect(server.calls.length).toBe(2); // first request + exactly one retry
    expect(sleeps).toEqual([RULES.retryPauseMs]);
    const set = db.updates[0].update.$set;
    expect(Object.keys(set).sort()).toEqual(["nearby.attemptedAt", "nearby.failures", "nearby.nextRetryAt"]);
    expect(set["nearby.failures"]).toBe(1);
    expect(set["nearby.nextRetryAt"].getTime()).toBe(NOW.getTime() + RULES.retryBackoffMs[0]);
  });

  test("backoff grows with repeated failures and is capped", async () => {
    const server = overpass(() => reply(null, 503));
    const db = store();
    await run(listing({ nearby: { failures: 1, key: "x" } }), server, db);
    expect(db.updates[0].update.$set["nearby.nextRetryAt"].getTime()).toBe(NOW.getTime() + RULES.retryBackoffMs[1]);
    await run(listing({ nearby: { failures: 9, key: "x" } }), server, db);
    expect(db.updates[1].update.$set["nearby.nextRetryAt"].getTime()).toBe(NOW.getTime() + RULES.retryBackoffMs[2]);
  });

  test("429 with Retry-After: waits that long (capped) and succeeds on the retry", async () => {
    sleeps.length = 0;
    const server = overpass((id, call, n) => (n === 1 ? reply(null, 429, { "retry-after": "3" }) : reply([])));
    const db = store();
    expect((await run(listing(), server, db)).status).toBe("updated");
    expect(sleeps).toEqual([3000]);
  });

  test("an answer with a runtime-error remark is treated as a failure and retried", async () => {
    sleeps.length = 0;
    const server = overpass((id, call, n) =>
      n === 1 ? reply({ elements: [], remark: "runtime error: Query timed out" }) : reply([]),
    );
    const db = store();
    expect((await run(listing(), server, db)).status).toBe("updated");
    expect(sleeps.length).toBe(1);
  });

  test("a network error or timeout is a failed refresh, not an exception", async () => {
    const server = overpass(() => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const db = store();
    const result = await run(listing(), server, db);
    expect(result.status).toBe("failed");
    expect(result.reason.includes("TimeoutError")).toBe(true);
  });

  test("an answer that is not what we asked for is not retried", async () => {
    const server = overpass(() => reply({ nonsense: true }));
    const db = store();
    expect((await run(listing(), server, db)).status).toBe("failed");
    expect(server.calls.length).toBe(1);
  });

  test("a bug that is not an Overpass problem is not swallowed", async () => {
    const server = overpass(() => reply([]));
    const db = { Listing: { updateOne: async () => { throw new Error("db down"); } } };
    expect((await fails(run(listing(), server, db))).message).toBe("db down");
  });
});

describe("when a fetch is allowed", () => {
  const sameKey = nearby.keyFor(PRECISE);
  const calls = async (doc, options = {}) => {
    const server = overpass(() => reply([]));
    const db = store();
    const result = await nearby.refreshListing(doc, {
      now: NOW,
      manual: options.manual,
      deps: { config, fetch: server.fetch, sleep, Listing: db.Listing },
    });
    return { result, called: server.calls.length };
  };

  test("manual refresh: not within 24 h of a good fetch, allowed after, allowed when the address moved", async () => {
    const recent = { fetchedAt: at(-2 * HOUR), attemptedAt: at(-2 * HOUR), key: sameKey };
    const r1 = await calls(listing({ nearby: recent }), { manual: true });
    expect(r1.result.status).toBe("cooldown");
    expect(r1.result.retryAt.getTime()).toBe(NOW.getTime() - 2 * HOUR + RULES.manualCooldownMs);
    expect(r1.called).toBe(0);

    const old = { fetchedAt: at(-25 * HOUR), attemptedAt: at(-25 * HOUR), key: sameKey };
    expect((await calls(listing({ nearby: old }), { manual: true })).result.status).toBe("updated");

    const moved = { fetchedAt: at(-2 * HOUR), attemptedAt: at(-2 * HOUR), key: "another-place" };
    expect((await calls(listing({ nearby: moved }), { manual: true })).result.status).toBe("updated");
  });

  test("never two attempts within 5 minutes", async () => {
    const justTried = { attemptedAt: at(-60 * 1000), failures: 1 };
    const r = await calls(listing({ nearby: justTried }), { manual: true });
    expect(r.result.status).toBe("throttled");
    expect(r.called).toBe(0);
  });

  test("publishing again within 7 days of a good fetch does not call Overpass", async () => {
    const fresh = { fetchedAt: at(-2 * 24 * HOUR), attemptedAt: at(-2 * 24 * HOUR), key: sameKey };
    const r = await calls(listing({ nearby: fresh }), { manual: false });
    expect(r.result.status).toBe("fresh");
    expect(r.called).toBe(0);
  });

  test("disabled, not published, deleted or without a location: no call", async () => {
    const off = readNearbyConfig({ NEARBY_ENABLED: "false" });
    const server = overpass(() => reply([]));
    const db = store();
    const base = { now: NOW, deps: { fetch: server.fetch, Listing: db.Listing, sleep } };
    expect((await nearby.refreshListing(listing(), { ...base, deps: { ...base.deps, config: off } })).status).toBe("disabled");
    const withConfig = { ...base, deps: { ...base.deps, config } };
    expect((await nearby.refreshListing(listing({ status: "draft" }), withConfig)).status).toBe("skipped");
    expect((await nearby.refreshListing(listing({ deletedAt: NOW }), withConfig)).status).toBe("skipped");
    expect((await nearby.refreshListing(listing({ geometry: undefined }), withConfig)).status).toBe("no_location");
    expect(server.calls.length).toBe(0);
  });

  test("manualVerdict answers without any network", () => {
    expect(nearby.manualVerdict(listing(), { now: NOW, config }).ok).toBe(true);
    expect(nearby.manualVerdict(listing(), { now: NOW, config: readNearbyConfig({ NEARBY_ENABLED: "false" }) }).reason).toBe("disabled");
  });
});

describe("retry job", () => {
  test("tries only what the database says is due, a few at a time", async () => {
    const asked = [];
    const Listing = {
      find: (filter) => ({
        sort: () => ({ limit: (n) => ({ lean: async () => { asked.push([filter, n]); return [listing(), listing({ _id: "6720a0000000000000000002" })]; } }) }),
      }),
    };
    const results = ["updated", "failed"];
    const refresh = async () => ({ status: results.shift() });
    const summary = await runRetryPass({ Listing, refresh, now: NOW, limit: 3 });
    expect(summary).toEqual({ tried: 2, updated: 1, failed: 1 });
    expect(asked[0][0].status).toBe("published");
    expect(asked[0][0]["nearby.nextRetryAt"].$lte).toBe(NOW);
    expect(asked[0][1]).toBe(3);
  });
});

describe("configuration", () => {
  test("off in tests by default, on elsewhere, contact goes into the User-Agent", () => {
    expect(readNearbyConfig({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(readNearbyConfig({ NODE_ENV: "development" }).enabled).toBe(true);
    expect(readNearbyConfig({ NODE_ENV: "test", NEARBY_ENABLED: "true" }).enabled).toBe(true);
    expect(readNearbyConfig({ NEARBY_CONTACT: "me@x.test" }).userAgent.includes("me@x.test")).toBe(true);
  });
  test("a bad or insecure address is refused", () => {
    let message = "";
    try { readNearbyConfig({ OVERPASS_URL: "not a url" }); } catch (e) { message = e.message; }
    expect(message.includes("OVERPASS_URL")).toBe(true);
    message = "";
    try { readNearbyConfig({ OVERPASS_URL: "http://x.test/api", NODE_ENV: "production" }); } catch (e) { message = e.message; }
    expect(message.includes("https")).toBe(true);
  });
});

describe("page views never reach Overpass (Signature #3)", () => {
  test("only the host controller imports the nearby service; no public controller, route or view helper does", () => {
    const root = path.join(__dirname, "..", "..", "src");
    const importers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && !/^nearby/.test(entry.name)) {
          if (/require\(\s*["'][^"']*\/nearby["']\s*\)/.test(fs.readFileSync(full, "utf8"))) {
            importers.push(path.relative(root, full).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(root);
    expect(importers).toEqual(["controllers/host.js"]);
  });
});
