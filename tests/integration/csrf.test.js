// P01-T10: CSRF protection on the real app and the real views. No database:
// every request here is stopped by the CSRF check or by isLoggedIn before any
// model is used.
const express = require("express");
const {
  createAgent,
  createTestApp,
  getCsrfToken,
} = require("../helpers/agent");

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const OBJECT_ID = "64b7f0c2a1b2c3d4e5f60718";

/**
 * Builds the app while recording every `app.use(path, router)` call, so the
 * mount path of each router is known (Express 5 keeps it only as a compiled
 * regular expression), then lists every route with its full path and methods.
 * A router mounted without a path makes the test fail loudly instead of being
 * skipped, so a new route can never silently escape the check.
 */
function appRouteTable() {
  const mounts = [];
  const originalUse = express.application.use;
  express.application.use = function patchedUse(...args) {
    const [first, ...rest] = args;
    if (typeof first === "string") {
      for (const h of rest.flat())
        if (h && Array.isArray(h.stack))
          mounts.push({ path: first, router: h });
    }
    return originalUse.apply(this, args);
  };
  let app;
  try {
    app = createTestApp();
  } finally {
    express.application.use = originalUse;
  }

  const join = (a, b) => (a + (b === "/" ? "" : b)).replace(/\/+/g, "/") || "/";
  const routes = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        routes.push({
          path: join(prefix, layer.route.path),
          methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
        });
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        const mount = mounts.find((m) => m.router === layer.handle);
        if (!mount) {
          throw new Error(
            "A router is mounted without a known path: mount it with app.use('/path', router) in createApp, or extend this test.",
          );
        }
        walk(layer.handle.stack, join(prefix, mount.path));
      }
    }
  };
  walk(app.router.stack, "");
  return { app, routes };
}

// Concrete URL for a route pattern such as /listings/:id/reviews/:reviewId.
const concretePath = (p) =>
  p
    .replace(/\/:[A-Za-z_]+/g, `/${OBJECT_ID}`)
    .replace(/\/\{\*[A-Za-z_]+\}/g, "/no/such/page");

describe("every state-changing route rejects a request without a token", () => {
  const { app, routes } = appRouteTable();
  const request = require("supertest");
  const start = (method, url) => request(app)[method.toLowerCase()](url);

  // The booking form is the one exception (P08-T03): a request without a valid
  // token is not a dead-end 403 but a redirect back to the GET checkout page
  // (the session may simply have ended). It books nothing; see
  // tests/integration/checkout.test.js for the details.
  const RECOVERED = "/listings/:id/checkout";
  const cases = [];
  const recovered = [];
  for (const route of routes) {
    const methods = route.methods.includes("_ALL")
      ? MUTATING
      : route.methods.filter((m) => MUTATING.includes(m));
    for (const method of methods) {
      const target = route.path === RECOVERED ? recovered : cases;
      target.push([method, concretePath(route.path), route.path]);
    }
  }

  test("the route table covers the known state-changing routes", () => {
    const seen = new Set(cases.map(([m, , p]) => `${m} ${p}`));
    for (const expected of [
      "POST /login",
      "POST /signup",
      "POST /logout",
      "POST /listings",
      "PUT /listings/:id",
      "DELETE /listings/:id",
      "POST /listings/:id/reviews",
      "DELETE /listings/:id/reviews/:reviewId",
    ]) {
      expect(seen).toContain(expected);
    }
    expect(recovered.map(([m, , p]) => `${m} ${p}`)).toEqual([
      "POST /listings/:id/checkout",
    ]);
  });

  test.each(recovered)(
    "%s %s (%s) -> redirect to the checkout page, not a booking, with no token or a wrong one",
    async (method, url) => {
      for (const token of [undefined, "wrong"]) {
        let req = start(method, url);
        if (token) req = req.set("X-CSRF-Token", token);
        const res = await req.type("form").send({});
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(url);
      }
    },
  );

  test.each(cases)("%s %s (%s) -> 403 without a token", async (method, url) => {
    const res = await start(method, url).type("form").send({});
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/reload the page/i);
  });

  test.each(cases)(
    "%s %s (%s) -> 403 with a wrong token",
    async (method, url) => {
      const res = await start(method, url)
        .set("X-CSRF-Token", "wrong")
        .type("form")
        .send({});
      expect(res.status).toBe(403);
    },
  );
});

describe("tokens", () => {
  test("pages expose the token in the layout <meta> tag", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Same session, same token.
    expect(await getCsrfToken(agent)).toBe(token);
  });

  test("the login and signup forms carry the token as a hidden field", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    for (const page of ["/login", "/signup"]) {
      const res = await agent.get(page);
      expect(res.text).toContain(
        `<input type="hidden" name="_csrf" value="${token}">`,
      );
    }
  });

  test("a valid token passes (header): POST /logout redirects", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    const res = await agent.post("/logout").set("X-CSRF-Token", token);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/listings");
  });

  test("a valid token passes (hidden field in a urlencoded body)", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    const res = await agent.post("/logout").type("form").send({ _csrf: token });
    expect(res.status).toBe(302);
  });

  test("a valid token passes (query string) for a method-override DELETE", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    // Anonymous: gets past CSRF and is stopped by isLoggedIn (302 to /login).
    const res = await agent.post(
      `/listings/${OBJECT_ID}?_method=DELETE&_csrf=${token}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  test("a multipart form sends the token in the query string (body is not parsed yet)", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    const without = await agent.post("/listings").field("listing[title]", "x");
    expect(without.status).toBe(403);
    const withToken = await agent
      .post(`/listings?_csrf=${token}`)
      .field("listing[title]", "x");
    expect(withToken.status).toBe(302); // past CSRF, then isLoggedIn -> /login
    expect(withToken.headers.location).toBe("/login");
  });

  test("a token from another session is rejected", async () => {
    const a = createAgent({ csrf: false });
    const b = createAgent({ csrf: false });
    const tokenOfB = await getCsrfToken(b);
    await getCsrfToken(a); // a has its own session
    const res = await a.post("/logout").set("X-CSRF-Token", tokenOfB);
    expect(res.status).toBe(403);
  });

  test("no session cookie (cookie jar lost): a stale token is rejected with the 403 page", async () => {
    const first = createAgent({ csrf: false });
    const token = await getCsrfToken(first);
    const fresh = createAgent({ csrf: false }); // new session, old form
    const res = await fresh.post("/logout").set("X-CSRF-Token", token);
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/Not allowed/);
  });

  test("a JSON client gets a JSON 403", async () => {
    const res = await createAgent({ csrf: false })
      .post("/api/anything")
      .set("Accept", "application/json");
    expect(res.status).toBe(403);
    expect(
      res.body.code || res.body.error?.code || JSON.stringify(res.body),
    ).toBeTruthy();
  });

  test("the rejection never echoes the submitted token", async () => {
    const res = await createAgent({ csrf: false })
      .post("/logout")
      .set("X-CSRF-Token", "SECRET-VALUE-123");
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("SECRET-VALUE-123");
  });

  test("logout regenerates the session: the old token stops working", async () => {
    const agent = createAgent({ csrf: false });
    const token = await getCsrfToken(agent);
    expect(
      (await agent.post("/logout").set("X-CSRF-Token", token)).status,
    ).toBe(302);
    const again = await agent.post("/logout").set("X-CSRF-Token", token);
    expect(again.status).toBe(403);
    const fresh = await getCsrfToken(agent);
    expect(fresh).not.toBe(token);
  });
});

describe("the test helper", () => {
  test("a default agent adds the token to POST/PUT/DELETE by itself", async () => {
    const agent = createAgent();
    expect((await agent.post("/logout")).status).toBe(302);
    expect((await agent.delete(`/listings/${OBJECT_ID}`)).status).toBe(302);
  });
});
