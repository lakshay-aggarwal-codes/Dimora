// P01-T04: typed errors and the error handler (status mapping, production
// safety, JSON variant, odd throws).
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidTransitionError,
} = require("../../src/utils/errors");
const ExpressError = require("../../src/utils/ExpressError");
const {
  createErrorHandler,
  normalizeError,
} = require("../../src/middleware/errors");
const { withErrorApp } = require("../helpers/errorApp");

const SECRET = "DB-PASSWORD-hunter2 at /srv/app/secret.js";

test("typed errors carry the right status and code", () => {
  const cases = [
    [new ValidationError(), 400, "validation_error"],
    [new ForbiddenError(), 403, "forbidden"],
    [new NotFoundError(), 404, "not_found"],
    [new ConflictError(), 409, "conflict"],
    [
      new InvalidTransitionError("pending", "completed"),
      409,
      "invalid_transition",
    ],
  ];
  for (const [err, status, code] of cases) {
    assert.ok(err instanceof AppError && err instanceof Error);
    assert.equal(err.statusCode, status);
    assert.equal(err.code, code);
    assert.equal(err.name, err.constructor.name);
  }
  const t = new InvalidTransitionError("pending", "completed");
  assert.equal(t.message, "Cannot change status from pending to completed.");
  assert.ok(t instanceof ConflictError);
  assert.equal(new NotFoundError().message, "Page Not Found");
});

test("legacy ExpressError is still an AppError with the same fields", () => {
  const err = new ExpressError(418, "teapot");
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 418);
  assert.equal(err.message, "teapot");
});

test("normalizeError maps Mongoose and driver errors", () => {
  const cast = new mongoose.Error.CastError("ObjectId", "abc", "_id");
  assert.equal(normalizeError(cast).status, 404);

  const validation = new mongoose.Error.ValidationError();
  assert.equal(normalizeError(validation).status, 400);

  const dup = Object.assign(new Error(`E11000 duplicate key ${SECRET}`), {
    code: 11000,
  });
  const n = normalizeError(dup);
  assert.equal(n.status, 409);
  assert.ok(!n.message.includes("hunter2"));

  const multer = Object.assign(new Error("File too large"), {
    name: "MulterError",
    code: "LIMIT_FILE_SIZE",
  });
  assert.equal(normalizeError(multer).status, 413);
  assert.equal(
    normalizeError(
      Object.assign(new Error("x"), {
        name: "MulterError",
        code: "LIMIT_UNEXPECTED_FILE",
      }),
    ).status,
    400,
  );

  const tooLarge = Object.assign(new Error("request entity too large"), {
    status: 413,
    expose: true,
  });
  assert.equal(normalizeError(tooLarge).status, 413);
});

test("5xx messages are never exposed, even from a typed error", () => {
  const n = normalizeError(new AppError(503, SECRET));
  assert.equal(n.status, 503);
  assert.ok(!n.message.includes("hunter2"));
});

test("non-Error throws become a generic 500", () => {
  for (const thrown of ["a string", 42, null, undefined, { secret: SECRET }]) {
    const n = normalizeError(thrown);
    assert.equal(n.status, 500);
    assert.ok(!JSON.stringify(n).includes("hunter2"));
  }
});

test("handler defers to Express when headers were already sent", () => {
  const handler = createErrorHandler({ isProduction: true });
  const err = new Error("late");
  let rendered = false;
  let passed;
  handler(
    err,
    { log: null },
    {
      headersSent: true,
      render: () => (rendered = true),
      status: () => (rendered = true),
    },
    (e) => (passed = e),
  );
  assert.equal(passed, err);
  assert.equal(rendered, false);
});

test("production: a thrown Error does not leak its message, stack or paths", async () => {
  await withErrorApp(
    {
      isProduction: true,
      routes: (app) =>
        app.get("/boom", () => {
          throw new Error(SECRET);
        }),
    },
    async (base) => {
      const res = await fetch(`${base}/boom`);
      const html = await res.text();
      assert.equal(res.status, 500);
      assert.match(html, /Something went wrong/);
      assert.match(html, /test-request-id/);
      for (const leak of [
        "hunter2",
        "/srv/app",
        "secret.js",
        " at ",
        "Error:",
      ]) {
        assert.ok(!html.includes(leak), `leaked: ${leak}`);
      }
    },
  );
});

test("development: the page shows the detail and the stack", async () => {
  await withErrorApp(
    {
      isProduction: false,
      routes: (app) =>
        app.get("/boom", () => {
          throw new Error("visible in dev");
        }),
    },
    async (base) => {
      const res = await fetch(`${base}/boom`);
      const html = await res.text();
      assert.equal(res.status, 500);
      assert.match(html, /visible in dev/);
      assert.match(html, /Development detail/);
    },
  );
});

test("typed errors render status-specific pages with the site navigation", async () => {
  await withErrorApp(
    {
      isProduction: true,
      routes: (app) => {
        app.get("/403", () => {
          throw new ForbiddenError("Hosts only.");
        });
        app.get("/404", () => {
          throw new NotFoundError();
        });
        app.get("/409", () => {
          throw new ConflictError("Dates were just taken.");
        });
        app.get("/400", () => {
          throw new ValidationError('"price" must be a number');
        });
        app.get("/legacy", () => {
          throw new ExpressError(400, "legacy message");
        });
      },
    },
    async (base) => {
      const expected = {
        "/403": [403, /Not allowed/, /Hosts only\./],
        "/404": [404, /Page Not Found/, /Page Not Found/],
        "/409": [409, /Conflict/, /Dates were just taken\./],
        "/400": [400, /Bad request/, /&#34;price&#34; must be a number/],
        "/legacy": [400, /Bad request/, /legacy message/],
      };
      for (const [path, [status, title, message]] of Object.entries(expected)) {
        const res = await fetch(base + path);
        const html = await res.text();
        assert.equal(res.status, status, path);
        assert.match(html, title, path);
        assert.match(html, message, path);
        assert.match(html, /navbar/, `${path} keeps the site navigation`);
      }
    },
  );
});

test("Mongoose errors thrown from a route map to 404 / 400 / 409 pages", async () => {
  await withErrorApp(
    {
      isProduction: true,
      routes: (app) => {
        app.get("/cast", () => {
          throw new mongoose.Error.CastError("ObjectId", "zzz", "_id");
        });
        app.get("/invalid", () => {
          throw new mongoose.Error.ValidationError();
        });
        app.get("/dup", () => {
          throw Object.assign(new Error(`E11000 ${SECRET}`), { code: 11000 });
        });
      },
    },
    async (base) => {
      assert.equal((await fetch(`${base}/cast`)).status, 404);
      assert.equal((await fetch(`${base}/invalid`)).status, 400);
      const dup = await fetch(`${base}/dup`);
      assert.equal(dup.status, 409);
      assert.ok(!(await dup.text()).includes("hunter2"));
    },
  );
});

test("async handlers and non-Error throws are handled (Express 5)", async () => {
  await withErrorApp(
    {
      isProduction: true,
      routes: (app) => {
        app.get("/async", async () => {
          throw new NotFoundError("gone");
        });
        app.get("/string", () => {
          throw SECRET;
        });
        app.get("/null", () => {
          throw null;
        });
      },
    },
    async (base) => {
      assert.equal((await fetch(`${base}/async`)).status, 404);
      const str = await fetch(`${base}/string`);
      assert.equal(str.status, 500);
      assert.ok(!(await str.text()).includes("hunter2"));

      // Express itself treats `throw null` as "no error" and falls through to
      // the 404 page; nothing is leaked either way.
      const nul = await fetch(`${base}/null`);
      assert.ok([404, 500].includes(nul.status));
      assert.ok(!(await nul.text()).includes("hunter2"));
    },
  );
});

test("/api paths and Accept: application/json get a JSON error body", async () => {
  await withErrorApp(
    {
      isProduction: true,
      routes: (app) => {
        app.get("/api/thing", () => {
          throw new NotFoundError("No such thing");
        });
        app.get("/api/boom", () => {
          throw new Error(SECRET);
        });
        app.get("/page", () => {
          throw new ForbiddenError("nope");
        });
      },
    },
    async (base) => {
      const nf = await fetch(`${base}/api/thing`);
      assert.equal(nf.status, 404);
      assert.match(nf.headers.get("content-type"), /application\/json/);
      // expect().toEqual: node:assert deep-equality compares prototypes, and
      // JSON parsed by fetch comes from another realm under Jest.
      expect(await nf.json()).toEqual({
        error: {
          status: 404,
          code: "not_found",
          message: "No such thing",
          requestId: "test-request-id",
        },
      });

      const boom = await fetch(`${base}/api/boom`);
      assert.equal(boom.status, 500);
      const text = await boom.text();
      assert.ok(!text.includes("hunter2") && !text.includes("stack"));

      const viaAccept = await fetch(`${base}/page`, {
        headers: { Accept: "application/json" },
      });
      assert.equal(viaAccept.status, 403);
      assert.equal((await viaAccept.json()).error.code, "forbidden");

      const html = await fetch(`${base}/page`, {
        headers: { Accept: "text/html" },
      });
      assert.match(html.headers.get("content-type"), /text\/html/);
    },
  );
});

test("if the error page itself cannot render, a plain-text fallback is sent", async () => {
  const express = require("express");
  const app = express();
  // No view engine configured: render() fails, the fallback must still answer.
  app.get("/x", () => {
    throw new NotFoundError();
  });
  app.use(createErrorHandler({ isProduction: true }));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Page Not Found/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// P04-T03: too many photos in one upload says so
test("a multer file-count error gets its own message", () => {
  for (const code of ["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"]) {
    const n = normalizeError(
      Object.assign(new Error("Too many files"), { name: "MulterError", code }),
    );
    assert.equal(n.status, 400);
    assert.match(n.message, /at most 10 photos/);
  }
});
