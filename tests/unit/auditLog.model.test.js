// P14-T01: the audit log model validates its rows and refuses every change to
// an existing row. No database: the hooks throw before any query is sent.
const AuditLog = require("../../src/models/auditLog");

const valid = (extra) => ({
  action: "user.make_admin",
  targetType: "user",
  ...extra,
});

describe("AuditLog validation", () => {
  test("a minimal row is valid", async () => {
    await expect(new AuditLog(valid()).validate()).resolves.toBeUndefined();
  });

  test("the action must be lower-case, dot separated", async () => {
    for (const action of ["", "Suspend", "suspend", "user suspend", "user.Suspend"]) {
      await expect(new AuditLog(valid({ action })).validate()).rejects.toThrow();
    }
  });

  test("the target type must be one of the known types", async () => {
    await expect(new AuditLog(valid({ targetType: "banana" })).validate()).rejects.toThrow();
  });

  test("there is no updatedAt: a row is written once", () => {
    expect(AuditLog.schema.path("updatedAt")).toBeUndefined();
    expect(AuditLog.schema.path("createdAt")).toBeDefined();
  });
});

describe("AuditLog is append-only", () => {
  const refused = /cannot be changed or deleted/;

  test.each([
    ["updateOne", () => AuditLog.updateOne({}, { reason: "x" }).exec()],
    ["updateMany", () => AuditLog.updateMany({}, { reason: "x" }).exec()],
    ["replaceOne", () => AuditLog.replaceOne({}, valid()).exec()],
    ["findOneAndUpdate", () => AuditLog.findOneAndUpdate({}, { reason: "x" }).exec()],
    ["findOneAndDelete", () => AuditLog.findOneAndDelete({}).exec()],
    ["deleteOne", () => AuditLog.deleteOne({}).exec()],
    ["deleteMany", () => AuditLog.deleteMany({}).exec()],
    ["bulkWrite with a delete", () => AuditLog.bulkWrite([{ deleteOne: { filter: {} } }])],
    ["bulkWrite with an update", () => AuditLog.bulkWrite([{ updateOne: { filter: {}, update: { reason: "x" } } }])],
  ])("%s is refused", async (_name, run) => {
    await expect(run()).rejects.toThrow(refused);
  });

  test("saving an already stored row again is refused", async () => {
    const row = new AuditLog(valid());
    row.isNew = false; // as if it had been loaded from the database
    await expect(row.save()).rejects.toThrow(refused);
  });

  test("deleting a loaded document is refused", async () => {
    const row = new AuditLog(valid());
    row.isNew = false;
    await expect(row.deleteOne()).rejects.toThrow(refused);
  });
});
