// P17-T01: the authorization route matrix. Walks the router stack of the REAL
// app (createApp) and compares it with tests/helpers/routeMatrix.js:
//   1. every route the app registers has an entry (a new route fails here until
//      someone decides who may use it), and every entry still has a route;
//   2. the guards on the route are the ones its entry names (isLoggedIn,
//      authorize(<action>), adminGuard);
//   3. an anonymous request is turned away the way the entry says (302 to
//      /login, 401 JSON, or 404 for the admin area), without reaching a database.
const express = require("express");
const { createTestApp, createAgent } = require("../helpers/agent");
const { MATRIX, APP_LEVEL } = require("../helpers/routeMatrix");
const { isLoggedIn } = require("../../src/middleware/auth");
const { adminGuard } = require("../../src/middleware/admin");
const { actions } = require("../../src/policies");

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const OPEN_MUTATIONS = new Set(["POST /signup", "POST /login", "POST /logout"]);

// "/listings/:id" mounted at "/" or at a prefix, without double or trailing slashes.
function join(mount, path) {
  const full = (mount === "/" ? "" : mount) + (path === "/" ? "" : path);
  return full || "/";
}

/** [{ key: "GET /x", handlers: [fn], mount }] for the routes of one router. */
function routesOf(router, mount, { flagNested = true } = {}) {
  const found = [];
  for (const layer of router.stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      const methods = Object.keys(layer.route.methods).filter((m) => METHODS.includes(m));
      const verbs = layer.route.methods._all || !methods.length ? ["ALL"] : methods.map((m) => m.toUpperCase());
      for (const path of [].concat(layer.route.path)) {
        for (const verb of verbs) {
          found.push({ key: `${verb} ${join(mount, path)}`, handlers, mount, router });
        }
      }
    } else if (flagNested && layer.handle && layer.handle.stack) {
      // A router inside a router: its mount path cannot be recovered reliably,
      // so the matrix refuses it rather than skip its routes.
      found.push({ key: `NESTED ROUTER under ${mount}`, handlers: [], mount, router });
    }
  }
  return found;
}

/** Builds the app and records every router it mounts, with the path it is mounted at. */
function discover() {
  const mounts = [];
  const original = express.application.use;
  express.application.use = function use(...args) {
    const first = args[0];
    const path = typeof first === "string" ? first : Array.isArray(first) ? null : "/";
    for (const arg of args) {
      if (typeof arg === "function" && Array.isArray(arg.stack)) mounts.push({ path: path || "/", router: arg });
    }
    return original.apply(this, args);
  };
  let app;
  try {
    app = createTestApp();
  } finally {
    express.application.use = original;
  }
  const routes = mounts.flatMap((m) => routesOf(m.router, m.path));
  // The app's own router also holds the mounted routers as layers: only its routes count here.
  const own = routesOf(app.router || app._router, "/", { flagNested: false });
  return { app, routes, own };
}

/** Pure: what is missing from the matrix, and what the matrix lists that no longer exists. */
function compare(foundKeys, matrixKeys) {
  const found = new Set(foundKeys);
  const listed = new Set(matrixKeys);
  return {
    unlisted: [...found].filter((k) => !listed.has(k)).sort(),
    stale: [...listed].filter((k) => !found.has(k)).sort(),
  };
}

const discovered = discover();
const endpoints = discovered.routes;

describe("every route has a matrix entry", () => {
  test("the app registers no router inside a router", () => {
    expect(endpoints.filter((r) => r.key.startsWith("NESTED"))).toEqual([]);
  });

  test("no route is missing from tests/helpers/routeMatrix.js, and no entry is left over", () => {
    const { unlisted, stale } = compare(endpoints.map((r) => r.key), Object.keys(MATRIX));
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });

  test("no route is registered twice", () => {
    const keys = endpoints.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  test("routes the app registers itself are the known rate-limit counters and the catch-all", () => {
    const keys = discovered.own.map((r) => r.key);
    const { unlisted, stale } = compare(keys, Object.keys(APP_LEVEL));
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });

  test("the check itself notices an unlisted and a stale route", () => {
    expect(compare(["GET /a", "POST /b"], ["GET /a"])).toEqual({ unlisted: ["POST /b"], stale: [] });
    expect(compare(["GET /a"], ["GET /a", "GET /gone"])).toEqual({ unlisted: [], stale: ["GET /gone"] });
  });

  test("every entry is well formed", () => {
    const valid = new Set(["public", "login", "authorize", "inline-login", "admin"]);
    for (const [key, entry] of Object.entries(MATRIX)) {
      expect(valid.has(entry.access)).toBe(true);
      expect(typeof entry.who).toBe("string");
      expect(entry.who.length).toBeGreaterThan(10);
      expect(Boolean(entry.action)).toBe(entry.access === "authorize");
      if (entry.action) expect(actions()).toContain(entry.action);
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
    }
  });
});

describe("the guards are the ones the matrix names", () => {
  const entries = endpoints.filter((r) => MATRIX[r.key]).map((r) => [r.key, r, MATRIX[r.key]]);

  test.each(entries.filter(([, , m]) => m.access === "public"))(
    "%s is public: no login guard in front of it",
    (key, route) => {
      expect(route.handlers).not.toContain(isLoggedIn);
      expect(route.handlers.some((h) => h && h.policyAction)).toBe(false);
    },
  );

  test("the only public routes that change anything are signing up, in and out", () => {
    const mutating = entries
      .filter(([k, , m]) => m.access === "public" && !k.startsWith("GET "))
      .map(([k]) => k)
      .sort();
    expect(mutating).toEqual([...OPEN_MUTATIONS].sort());
  });

  test.each(entries.filter(([, , m]) => m.access === "login"))("%s needs isLoggedIn", (key, route) => {
    expect(route.handlers).toContain(isLoggedIn);
  });

  test.each(entries.filter(([, , m]) => m.access === "authorize"))(
    "%s: isLoggedIn, then authorize with the named action",
    (key, route, matrix) => {
      const login = route.handlers.indexOf(isLoggedIn);
      const guard = route.handlers.findIndex((h) => h && h.policyAction === matrix.action);
      expect(login).toBeGreaterThanOrEqual(0);
      expect(guard).toBeGreaterThan(login);
      // and no other action sneaks in
      expect(route.handlers.filter((h) => h && h.policyAction).map((h) => h.policyAction)).toEqual([matrix.action]);
    },
  );

  test.each(entries.filter(([, , m]) => m.access === "inline-login"))(
    "%s has no guard in front: the handler answers visitors itself",
    (key, route) => {
      expect(route.handlers).not.toContain(isLoggedIn);
    },
  );

  test("everything under /admin is the admin class, mounted behind adminGuard, and nothing else is", () => {
    for (const [key, route, matrix] of entries) {
      const path = key.split(" ")[1];
      const inAdmin = path === "/admin" || path.startsWith("/admin/");
      expect(inAdmin).toBe(matrix.access === "admin");
      if (inAdmin) expect(route.router.stack[0].handle).toBe(adminGuard);
    }
  });

  test("every write in the admin area is audited", () => {
    const writes = entries.filter(([k, , m]) => m.access === "admin" && !k.startsWith("GET "));
    expect(writes.length).toBeGreaterThan(0);
    for (const [key, route] of writes) {
      expect(route.handlers.some((h) => h && h.auditedMutation === true)).toBe(true);
      expect(key).toMatch(/^POST /);
    }
  });
});

// ---- anonymous requests through the real app --------------------------------

const SAMPLE = "507f1f77bcf86cd799439011";
const fill = (path) => path.replace(/:n\b/, "1").replace(/:key\b/, "basics").replace(/:[A-Za-z]+/g, SAMPLE);
const guarded = Object.entries(MATRIX).filter(([, m]) => m.access !== "public");

describe("a visitor is turned away the way the matrix says", () => {
  let agent;
  beforeAll(() => {
    agent = createAgent();
  });

  const call = (key) => {
    const [method, path] = key.split(" ");
    return agent[method.toLowerCase()](fill(path));
  };

  test.each(guarded.filter(([, m]) => m.access === "login" || m.access === "authorize"))(
    "%s -> redirect to /login",
    async (key) => {
      const res = await call(key);
      expect([302, 303]).toContain(res.status);
      expect(res.headers.location).toBe("/login");
    },
  );

  test.each(guarded.filter(([, m]) => m.access === "inline-login"))("%s -> 401 JSON", async (key) => {
    const res = await call(key);
    expect(res.status).toBe(401);
    expect(res.type).toMatch(/json/);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  test.each(guarded.filter(([, m]) => m.access === "admin"))("%s -> 404 (the area does not show itself)", async (key) => {
    const res = await call(key);
    expect(res.status).toBe(404);
  });
});
