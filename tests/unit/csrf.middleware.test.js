// P01-T10: the CSRF middleware on its own (fake req/res, no app, no database).
const {
  csrfProtection,
  getToken,
  tokensMatch,
} = require("../../src/middleware/csrf");
const { ForbiddenError } = require("../../src/utils/errors");

function fakeReq({
  method = "POST",
  session = {},
  headers = {},
  query,
  body,
} = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method,
    session,
    query,
    body,
    get: (name) => lower[name.toLowerCase()],
  };
}

function run(req) {
  const res = { locals: {} };
  let error;
  let called = 0;
  csrfProtection()(req, res, (err) => {
    called += 1;
    error = err;
  });
  return { res, error, called };
}

describe("getToken", () => {
  test("creates one random token per session and keeps it", () => {
    const req = fakeReq({ session: {} });
    const first = getToken(req);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getToken(req)).toBe(first);
    expect(getToken(fakeReq({ session: {} }))).not.toBe(first);
  });

  test("no session: no token", () => {
    expect(getToken(fakeReq({ session: null }))).toBeUndefined();
  });
});

describe("tokensMatch", () => {
  test("equal strings match; everything else does not", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("abc", "")).toBe(false);
    expect(tokensMatch("abc", undefined)).toBe(false);
    expect(tokensMatch(undefined, undefined)).toBe(false);
    expect(tokensMatch("abc", ["abc"])).toBe(false);
  });
});

describe("csrfProtection", () => {
  test.each(["GET", "HEAD", "OPTIONS"])(
    "%s passes without a token and exposes it",
    (method) => {
      const req = fakeReq({ method });
      const { res, error, called } = run(req);
      expect(called).toBe(1);
      expect(error).toBeUndefined();
      expect(res.locals.csrfToken).toBe(req.session.csrfToken);
    },
  );

  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s without a token is a 403 ForbiddenError",
    (method) => {
      const { error, called } = run(fakeReq({ method, body: {} }));
      expect(called).toBe(1);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe("csrf_invalid");
    },
  );

  test("a wrong token is rejected", () => {
    const { error } = run(fakeReq({ headers: { "X-CSRF-Token": "nope" } }));
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  test("no session at all is rejected", () => {
    const { error } = run(
      fakeReq({ session: null, headers: { "X-CSRF-Token": "x" } }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  test("accepted from the header, the query string and the body", () => {
    const session = {};
    const token = getToken({ session });
    for (const req of [
      fakeReq({ session, headers: { "X-CSRF-Token": token } }),
      fakeReq({ session, query: { _csrf: token } }),
      fakeReq({ session, body: { _csrf: token } }),
    ]) {
      const { error, called } = run(req);
      expect(called).toBe(1);
      expect(error).toBeUndefined();
    }
  });

  test("an array in the query string or body is not accepted", () => {
    const session = {};
    const token = getToken({ session });
    expect(
      run(fakeReq({ session, query: { _csrf: [token] } })).error,
    ).toBeInstanceOf(ForbiddenError);
    expect(
      run(fakeReq({ session, body: { _csrf: [token] } })).error,
    ).toBeInstanceOf(ForbiddenError);
  });

  test("the checked body field is removed so validation schemas never see it", () => {
    const session = {};
    const token = getToken({ session });
    const req = fakeReq({
      session,
      body: { _csrf: token, listing: { title: "x" } },
    });
    expect(run(req).error).toBeUndefined();
    expect(req.body).toEqual({ listing: { title: "x" } });
  });
});
