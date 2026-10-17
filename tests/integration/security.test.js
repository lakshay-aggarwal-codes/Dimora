// P01-T09: security headers, CSP nonces, cookie flags, rate limits and POST
// logout. Real app and views, no database (the model layer is stubbed where a
// request would reach it).
const { createAgent } = require("../helpers/agent");
const { testConfig } = require("../helpers/config");
const User = require("../../src/models/user");
const { stubListings } = require("../helpers/listingsStub");

afterEach(() => {
  jest.restoreAllMocks();
});

const nonceOf = (res) =>
  (res.headers["content-security-policy"].match(/'nonce-([^']+)'/) || [])[1];

describe("response headers", () => {
  test("CSP, nosniff and referrer policy are set; X-Powered-By is not", async () => {
    const res = await createAgent().get("/login");
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("https://api.mapbox.com");
    expect(csp).toContain("https://res.cloudinary.com");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("https://fonts.gstatic.com");
    expect(csp).toContain("script-src-attr 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("static files carry the headers too", async () => {
    const res = await createAgent().get("/js/map.js");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("development: no HSTS and no upgrade-insecure-requests (plain http)", async () => {
    const res = await createAgent().get("/login");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  test("production: HSTS and upgrade-insecure-requests", async () => {
    const res = await createAgent({
      config: testConfig({ isProduction: true }),
    }).get("/login");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(res.headers["content-security-policy"]).toContain(
      "upgrade-insecure-requests",
    );
  });
});

describe("CSP nonce", () => {
  test("every inline script and style carries this request's nonce", async () => {
    stubListings([]);
    const res = await createAgent().get("/listings");
    expect(res.status).toBe(200);
    const nonce = nonceOf(res);
    expect(nonce).toBeTruthy();

    const inline = [
      ...(res.text.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []),
      ...(res.text.match(/<style[^>]*>/g) || []),
    ];
    expect(inline.length).toBeGreaterThanOrEqual(1); // the index script
    expect(res.text).not.toMatch(/<style[\s>]/); // styles live in public/css (P03-T01)
    for (const tag of inline) expect(tag).toContain(`nonce="${nonce}"`);
    expect(res.text).not.toMatch(/\son[a-z]+="/); // no inline event handlers
  });

  test("the nonce is different on every request", async () => {
    const agent = createAgent();
    const a = nonceOf(await agent.get("/login"));
    const b = nonceOf(await agent.get("/login"));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("session cookie", () => {
  const cookieOf = (res) => (res.headers["set-cookie"] || []).join("; ");

  test("production: HttpOnly, SameSite=Lax, Secure, fixed Max-Age", async () => {
    const agent = createAgent({ config: testConfig({ isProduction: true }) });
    // trust proxy = 1 in production, so the proxy's header makes it a secure request.
    const res = await agent
      .get("/listings/new") // anonymous: stores the redirect target in the session
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(302);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Expires=/i); // express-session sends the fixed lifetime as Expires
  });

  test("development: HttpOnly and SameSite=Lax but not Secure (http)", async () => {
    const res = await createAgent().get("/listings/new");
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);
  });
});

describe("rate limits", () => {
  const bad = { username: "someone", password: "wrong-password" };

  test("the 6th failed login in a row is a 429 page", async () => {
    // Every attempt fails, without touching a database.
    jest
      .spyOn(User, "authenticate")
      .mockReturnValue((username, password, done) =>
        done(null, false, { message: "Incorrect username or password" }),
      );
    const agent = createAgent();

    for (let i = 1; i <= 5; i += 1) {
      const res = await agent.post("/login").type("form").send(bad);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    }
    const sixth = await agent.post("/login").type("form").send(bad);
    expect(sixth.status).toBe(429);
    expect(sixth.text).toContain("Too many requests");
    expect(sixth.headers["retry-after"]).toBeDefined();
  });

  test("the 11th signup in an hour is a 429", async () => {
    jest.spyOn(User, "register").mockRejectedValue(new Error("stubbed"));
    const agent = createAgent();
    const form = { username: "a", email: "a@example.com", password: "x" };

    for (let i = 1; i <= 10; i += 1) {
      const res = await agent.post("/signup").type("form").send(form);
      expect(res.status).toBe(302);
    }
    const eleventh = await agent.post("/signup").type("form").send(form);
    expect(eleventh.status).toBe(429);
  });

  test("a new app (fresh limiter) is not affected by another app's attempts", async () => {
    jest
      .spyOn(User, "authenticate")
      .mockReturnValue((u, p, done) => done(null, false, { message: "no" }));
    const first = createAgent();
    for (let i = 0; i < 6; i += 1) {
      await first.post("/login").type("form").send(bad);
    }
    const res = await createAgent().post("/login").type("form").send(bad);
    expect(res.status).toBe(302);
  });
});

describe("logout", () => {
  test("GET /logout is a 404 (logging out needs a POST)", async () => {
    const res = await createAgent().get("/logout");
    expect(res.status).toBe(404);
  });

  test("POST /logout redirects to the listings", async () => {
    const res = await createAgent().post("/logout");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/listings");
  });
});
