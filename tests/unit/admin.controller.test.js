// P14-T02: the admin user handlers with the service stubbed. They must return
// what auditedMutation needs (an audit entry), never respond themselves, and
// turn a refusal into AdminRefusal (no audit row, nothing changed).
const { ObjectId } = require("mongoose").Types;
const userAdmin = require("../../src/services/userAdmin");
const controller = require("../../src/controllers/admin");
const { AdminRefusal } = require("../../src/middleware/admin");
const { NotFoundError } = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const admin = { _id: new ObjectId(), username: "boss", role: "admin", status: "active" };
const target = { _id: new ObjectId(), username: "ann" };
const makeReq = (extra) => ({ user: admin, params: { id: String(target._id) }, body: {}, query: {}, sessionStore: { s: 1 }, ...extra });

describe("suspendUser handler", () => {
  test("returns the audit entry with reason, target and details, and a redirect", async () => {
    const spy = jest.spyOn(userAdmin, "suspendUser").mockResolvedValue({
      user: target,
      reason: "spam listings",
      details: { listingsHidden: 2 },
    });
    const req = makeReq({ body: { reason: "spam listings" } });
    const out = await controller.suspendUser(req);

    expect(spy).toHaveBeenCalledWith({ admin, id: String(target._id), reason: "spam listings", store: req.sessionStore });
    expect(out.audit).toEqual({
      action: "user.suspend",
      targetType: "user",
      targetId: target._id,
      reason: "spam listings",
      details: { listingsHidden: 2 },
    });
    expect(out.redirectTo).toBe(`/admin/users/${target._id}`);
    expect(out.flash).toMatch(/ann/);
  });

  test("a refusal from the service becomes AdminRefusal pointing back at the account", async () => {
    jest.spyOn(userAdmin, "suspendUser").mockRejectedValue(new userAdmin.UserAdminError("You cannot suspend the last admin."));
    const err = await controller.suspendUser(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AdminRefusal);
    expect(err.message).toBe("You cannot suspend the last admin.");
    expect(err.redirectTo).toBe(`/admin/users/${target._id}`);
  });

  test("a malformed id goes back to the list; an unexpected error is not hidden", async () => {
    jest.spyOn(userAdmin, "suspendUser").mockRejectedValue(new userAdmin.UserAdminError("That account does not exist."));
    const refusal = await controller.suspendUser(makeReq({ params: { id: "nope" } })).catch((e) => e);
    expect(refusal.redirectTo).toBe("/admin/users");

    const boom = new Error("db down");
    jest.spyOn(userAdmin, "suspendUser").mockRejectedValue(boom);
    await expect(controller.suspendUser(makeReq())).rejects.toBe(boom);
  });

  test("a body that is not an object or a reason that is not text reaches the service as undefined", async () => {
    const spy = jest.spyOn(userAdmin, "suspendUser").mockResolvedValue({ user: target, reason: "x", details: {} });
    await controller.suspendUser(makeReq({ body: { reason: ["a", "b"] } }));
    await controller.suspendUser(makeReq({ body: undefined }));
    expect(spy.mock.calls[0][0].reason).toBeUndefined();
    expect(spy.mock.calls[1][0].reason).toBeUndefined();
  });
});

describe("reinstateUser handler", () => {
  test("returns user.reinstate with the reason", async () => {
    jest.spyOn(userAdmin, "reinstateUser").mockResolvedValue({
      user: target,
      reason: "appeal accepted",
      details: { listingsRestored: 1 },
    });
    const out = await controller.reinstateUser(makeReq({ body: { reason: "appeal accepted" } }));
    expect(out.audit).toMatchObject({ action: "user.reinstate", targetType: "user", reason: "appeal accepted" });
    expect(out.redirectTo).toBe(`/admin/users/${target._id}`);
  });

  test("a refusal becomes AdminRefusal", async () => {
    jest.spyOn(userAdmin, "reinstateUser").mockRejectedValue(new userAdmin.UserAdminError("Only a suspended account can be reinstated."));
    await expect(controller.reinstateUser(makeReq())).rejects.toBeInstanceOf(AdminRefusal);
  });
});

describe("read handlers", () => {
  const makeRes = () => ({ render: jest.fn() });

  test("users: only plain-string query values reach the search", async () => {
    const spy = jest.spyOn(userAdmin, "searchUsers").mockResolvedValue({ rows: [] });
    const res = makeRes();
    await controller.users(makeReq({ query: { q: ["a", "b"], status: "suspended", page: { $gt: "" } } }), res);
    expect(spy).toHaveBeenCalledWith({ q: undefined, status: "suspended", page: undefined });
    expect(res.render).toHaveBeenCalledWith("admin/users", expect.objectContaining({ pageTitle: "Users" }));
  });

  test("user: unknown account is a 404; own account is flagged", async () => {
    jest.spyOn(userAdmin, "getUserSummary").mockResolvedValueOnce(null);
    await expect(controller.user(makeReq(), makeRes())).rejects.toBeInstanceOf(NotFoundError);

    jest.spyOn(userAdmin, "getUserSummary").mockResolvedValueOnce({ user: admin });
    const res = makeRes();
    await controller.user(makeReq({ params: { id: String(admin._id) } }), res);
    expect(res.render.mock.calls[0][1].isSelf).toBe(true);
  });
});
