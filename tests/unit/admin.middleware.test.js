// P14-T01: adminGuard and auditedMutation, no app and no database.
const { ObjectId } = require("mongoose").Types;
const audit = require("../../src/services/audit");
const { adminGuard, auditedMutation, AdminRefusal } = require("../../src/middleware/admin");
const { NotFoundError } = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const person = (extra) => ({ _id: new ObjectId(), role: "member", status: "active", ...extra });
const makeRes = () => ({
  locals: {},
  headersSent: false,
  set: jest.fn(),
  redirect: jest.fn(),
});

describe("adminGuard", () => {
  test.each([
    ["a visitor", undefined],
    ["a member", person()],
    ["a suspended admin", person({ role: "admin", status: "suspended" })],
    ["a deleted admin", person({ role: "admin", status: "deleted" })],
  ])("%s gets the ordinary 404", (_who, user) => {
    const next = jest.fn();
    expect(() => adminGuard({ user }, makeRes(), next)).toThrow(NotFoundError);
    expect(next).not.toHaveBeenCalled();
  });

  test("an active admin continues, and the page is not cached", () => {
    const res = makeRes();
    const next = jest.fn();
    adminGuard({ user: person({ role: "admin" }) }, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  test("an admin account from before the status field existed still works", () => {
    const next = jest.fn();
    adminGuard({ user: { _id: new ObjectId(), role: "admin" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe("auditedMutation", () => {
  const run = (middleware, req, res) =>
    new Promise((resolve) => {
      const next = jest.fn((err) => resolve({ next, err }));
      middleware(req, res, next);
      // A handler that answers without calling next(): resolve on the redirect.
      res.redirect.mockImplementation(() => resolve({ next }));
    });
  const makeReq = () => ({ user: person({ role: "admin" }), flash: jest.fn() });

  test("records exactly one audit row, then redirects", async () => {
    const record = jest.spyOn(audit, "record").mockImplementation(async ({ req }) => {
      req.auditRecorded = (req.auditRecorded || 0) + 1;
    });
    const req = makeReq();
    const res = makeRes();
    const handler = jest.fn(async () => ({
      audit: { action: "user.suspend", targetType: "user", reason: "Spam" },
      redirectTo: "/admin/users",
      flash: "Done.",
    }));

    const { err } = await run(auditedMutation(handler), req, res);

    expect(err).toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ action: "user.suspend", req });
    expect(res.redirect).toHaveBeenCalledWith("/admin/users");
    expect(req.flash).toHaveBeenCalledWith("success", "Done.");
  });

  test("a handler that returns no audit entry fails and sends no answer", async () => {
    const record = jest.spyOn(audit, "record");
    const res = makeRes();
    const { err } = await run(
      auditedMutation(async () => ({ redirectTo: "/admin" })),
      makeReq(),
      res,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/no audit entry/);
    expect(record).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test("a handler that returns nothing at all fails too", async () => {
    const { err } = await run(auditedMutation(async () => undefined), makeReq(), makeRes());
    expect(err.message).toMatch(/no audit entry/);
  });

  test("a handler that answers the request itself fails", async () => {
    const res = makeRes();
    const { err } = await run(
      auditedMutation(async (req, response) => {
        response.headersSent = true;
        return { audit: { action: "user.suspend", targetType: "user" } };
      }),
      makeReq(),
      res,
    );
    expect(err.message).toMatch(/responded itself/);
  });

  test("a record() that did not count itself fails (never silently passes)", async () => {
    jest.spyOn(audit, "record").mockResolvedValue({});
    const { err } = await run(
      auditedMutation(async () => ({ audit: { action: "user.suspend", targetType: "user" } })),
      makeReq(),
      makeRes(),
    );
    expect(err.message).toMatch(/exactly one audit entry/);
  });

  test("an error in the handler goes to next(), and nothing is logged", async () => {
    const record = jest.spyOn(audit, "record");
    const boom = new Error("boom");
    const { err } = await run(
      auditedMutation(async () => {
        throw boom;
      }),
      makeReq(),
      makeRes(),
    );
    expect(err).toBe(boom);
    expect(record).not.toHaveBeenCalled();
  });

  test("a failing audit write is an error, not a success", async () => {
    jest.spyOn(audit, "record").mockRejectedValue(new Error("db down"));
    const res = makeRes();
    const { err } = await run(
      auditedMutation(async () => ({ audit: { action: "user.suspend", targetType: "user" } })),
      makeReq(),
      res,
    );
    expect(err.message).toBe("db down");
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test("the counter starts at zero for every request", async () => {
    jest.spyOn(audit, "record").mockImplementation(async ({ req }) => {
      req.auditRecorded += 1;
    });
    const req = { ...makeReq(), auditRecorded: 5 };
    const { err } = await run(
      auditedMutation(async () => ({ audit: { action: "user.suspend", targetType: "user" } })),
      req,
      makeRes(),
    );
    expect(err).toBeUndefined();
    expect(req.auditRecorded).toBe(1);
  });

  test("a refusal flashes the message, redirects and writes no audit row", async () => {
    const record = jest.spyOn(audit, "record");
    const req = makeReq();
    const res = makeRes();
    const { err } = await run(
      auditedMutation(async () => {
        throw new AdminRefusal("You cannot suspend your own account.", "/admin/users/1");
      }),
      req,
      res,
    );
    expect(err).toBeUndefined();
    expect(req.flash).toHaveBeenCalledWith("error", "You cannot suspend your own account.");
    expect(res.redirect).toHaveBeenCalledWith("/admin/users/1");
    expect(record).not.toHaveBeenCalled();
  });

  test("a refusal defaults to the admin home page", () => {
    expect(new AdminRefusal("No.").redirectTo).toBe("/admin");
  });
});
