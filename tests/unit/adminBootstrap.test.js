// P14-T01: promoteToAdmin with the models stubbed (no database).
const { ObjectId } = require("mongoose").Types;
const User = require("../../src/models/user");
const audit = require("../../src/services/audit");
const { promoteToAdmin, BootstrapError, ACTOR_LABEL } = require("../../src/services/adminBootstrap");

afterEach(() => jest.restoreAllMocks());

const account = (extra) => ({ _id: new ObjectId(), username: "ann", role: "member", status: "active", ...extra });

function stub({ found, modified = 1 } = {}) {
  const findOne = jest.spyOn(User, "findOne").mockResolvedValue(found ?? null);
  const updateOne = jest.spyOn(User, "updateOne").mockResolvedValue({ modifiedCount: modified });
  const record = jest.spyOn(audit, "record").mockResolvedValue({});
  return { findOne, updateOne, record };
}

test("promotes an active member and writes one audit row", async () => {
  const user = account();
  const { findOne, updateOne, record } = stub({ found: user });

  const out = await promoteToAdmin("  Ann@Example.COM ");

  expect(out).toEqual({ changed: true, username: "ann" });
  expect(findOne).toHaveBeenCalledWith({ email: "ann@example.com" });
  expect(updateOne.mock.calls[0][1]).toEqual({ $set: { role: "admin" } });
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({
    actorLabel: ACTOR_LABEL,
    action: "user.make_admin",
    targetType: "user",
    targetId: user._id,
    details: { username: "ann", previousRole: "member" },
  });
});

test("the audit row holds no email address", async () => {
  const { record } = stub({ found: account() });
  await promoteToAdmin("ann@example.com");
  expect(JSON.stringify(record.mock.calls[0][0])).not.toMatch(/example\.com/);
});

test("an admin already: nothing changes and nothing is logged", async () => {
  const { updateOne, record } = stub({ found: account({ role: "admin" }) });
  expect(await promoteToAdmin("ann@example.com")).toEqual({ changed: false, username: "ann" });
  expect(updateOne).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test("a change lost to a concurrent writer is not logged", async () => {
  const { record } = stub({ found: account(), modified: 0 });
  expect((await promoteToAdmin("ann@example.com")).changed).toBe(false);
  expect(record).not.toHaveBeenCalled();
});

test("an unknown email is a readable error and writes nothing", async () => {
  const { updateOne, record } = stub({ found: null });
  await expect(promoteToAdmin("nobody@example.com")).rejects.toThrow(/No account has that email/);
  expect(updateOne).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test.each(["suspended", "deleted"])("a %s account cannot become an admin", async (status) => {
  const { updateOne } = stub({ found: account({ status }) });
  await expect(promoteToAdmin("ann@example.com")).rejects.toThrow(BootstrapError);
  expect(updateOne).not.toHaveBeenCalled();
});

test.each([undefined, null, "", "not-an-email", 42, { $ne: "" }, ["a@b.co"]])(
  "%p is rejected before the database is asked",
  async (input) => {
    const { findOne } = stub();
    await expect(promoteToAdmin(input)).rejects.toThrow(BootstrapError);
    expect(findOne).not.toHaveBeenCalled();
  },
);
