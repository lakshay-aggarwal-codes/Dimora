// P17-T02: the guard, the form parser limits and header handling, through a
// real Express app with the same parser options as src/app.js.
const express = require("express");
const request = require("supertest");
const { inputGuard, URLENCODED_OPTIONS } = require("../../src/middleware/inputGuard");
const { safeRedirectPath } = require("../../src/utils/safeRedirect");

function app() {
  const a = express();
  a.use(express.urlencoded(URLENCODED_OPTIONS));
  a.use(inputGuard);
  const reached = { count: 0 };
  a.all("/echo", (req, res) => {
    reached.count += 1;
    res.json({ query: req.query, body: req.body });
  });
  // Same pattern as src/controllers: a redirect built from a path parameter.
  a.get("/go/:id", (req, res) => res.redirect(`/listings/${req.params.id}`));
  a.get("/next", (req, res) => res.redirect(safeRedirectPath(req.query.next, "/")));
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).send(err.message));
  a.reached = reached;
  return a;
}

describe("operator and path injection", () => {
  test("login-shaped body with an operator object is refused before any handler runs", async () => {
    const a = app();
    const res = await request(a).post("/echo").type("form").send("username[$ne]=&password=x");
    expect(res.status).toBe(400);
    expect(a.reached.count).toBe(0);
  });

  test("nested listing fields with operators are refused; a normal form still works", async () => {
    const a = app();
    const bad = await request(a).post("/echo").type("form").send("listing[title][$regex]=.*&listing[price]=10");
    expect(bad.status).toBe(400);
    const good = await request(a).post("/echo").type("form").send("listing[title]=Sea+house&listing[price]=10&amenities=wifi&amenities=pool");
    expect(good.status).toBe(200);
    expect(good.body.body).toEqual({ listing: { title: "Sea house", price: "10" }, amenities: ["wifi", "pool"] });
  });

  test("query strings: operator-looking keys are refused", async () => {
    const a = app();
    for (const url of ["/echo?email[$ne]=x", "/echo?$where=1", "/echo?a.b=1", "/echo?__proto__[x]=1"]) {
      expect((await request(a).get(url)).status).toBe(400);
    }
    expect(a.reached.count).toBe(0);
  });

  test("a NUL byte is refused", async () => {
    const res = await request(app()).get("/echo?q=a%00b");
    expect(res.status).toBe(400);
  });
});

describe("duplicate parameters (HPP)", () => {
  test("a repeated query parameter reaches the handler as an array: parsers must expect it (see inputParsers.test.js)", async () => {
    const res = await request(app()).get("/echo?q=a&q=b");
    expect(res.status).toBe(200);
    expect(res.body.query.q).toEqual(["a", "b"]);
  });
});

describe("oversize input", () => {
  test("a form body over 100 kb is a 413", async () => {
    const res = await request(app()).post("/echo").type("form").send(`a=${"x".repeat(150 * 1024)}`);
    expect(res.status).toBe(413);
  });

  test("more than 1000 parameters is a 413", async () => {
    const body = Array.from({ length: 1500 }, (_, i) => `k${i}=1`).join("&");
    const res = await request(app()).post("/echo").type("form").send(body);
    expect(res.status).toBe(413);
  });
});

describe("CRLF in headers", () => {
  test("a path parameter with CR LF cannot add a response header or split the response", async () => {
    const res = await request(app()).get("/go/x%0d%0aX-Evil:%201");
    expect(res.status).toBe(302);
    expect(res.headers["x-evil"]).toBe(undefined);
    expect(/[\r\n]/.test(res.headers.location)).toBe(false);
    expect(res.headers.location.includes("%0D%0A")).toBe(true);
  });

  test("a `next` value with CR LF or a foreign host falls back to /", async () => {
    const a = app();
    for (const next of ["/ok%0d%0aSet-Cookie:%20a=b", "//evil.test", "/\\evil.test", "https://evil.test/", "javascript:alert(1)"]) {
      const res = await request(a).get(`/next?next=${next}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.headers["set-cookie"]).toBe(undefined);
    }
    expect((await request(a).get("/next?next=/listings%3Fq%3D1")).headers.location).toBe("/listings?q=1");
  });
});
