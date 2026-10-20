// P14-T01: services/audit with the model stubbed (no database).
const { ObjectId } = require("mongoose").Types;
const AuditLog = require("../../src/models/auditLog");
const audit = require("../../src/services/audit");

afterEach(() => jest.restoreAllMocks());

const admin = { _id: new ObjectId(), username: "boss", role: "admin" };
const entry = (extra) => ({
  action: "user.suspend",
  targetType: "user",
  targetId: new ObjectId(),
  reason: "Spam",
  ...extra,
});

describe("record", () => {
  test("writes one row for the logged-in admin and counts it on the request", async () => {
    const create = jest.spyOn(AuditLog, "create").mockImplementation(async ([doc]) => [doc]);
    const req = { user: admin, id: "req-1" };
    const row = await audit.record(entry({ details: { from: "active", to: "suspended" }, req }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(row.actor).toBe(admin._id);
    expect(row.action).toBe("user.suspend");
    expect(row.reason).toBe("Spam");
    expect(row.requestId).toBe("req-1");
    expect(req.auditRecorded).toBe(1);
  });

  test("passes a transaction session through", async () => {
    const create = jest.spyOn(AuditLog, "create").mockImplementation(async ([doc]) => [doc]);
    const session = { id: "s" };
    await audit.record(entry({ actor: admin }), { session });
    expect(create.mock.calls[0][1]).toEqual({ session });
  });

  test("without an admin, a label says who acted (the make-admin script)", async () => {
    jest.spyOn(AuditLog, "create").mockImplementation(async ([doc]) => [doc]);
    const row = await audit.record(entry({ actorLabel: "cli:make-admin" }));
    expect(row.actor).toBeNull();
    expect(row.actorLabel).toBe("cli:make-admin");
  });

  test("an entry with neither actor nor label is refused and nothing is written", async () => {
    const create = jest.spyOn(AuditLog, "create");
    await expect(audit.record(entry())).rejects.toThrow(/actor/);
    expect(create).not.toHaveBeenCalled();
  });

  test.each(["password", "newPassword", "hash", "salt", "sessionToken", "secret", "cookie", "authorization"])(
    "details with a %s key are refused, also when nested",
    async (key) => {
      const create = jest.spyOn(AuditLog, "create");
      await expect(audit.record(entry({ actor: admin, details: { ok: 1, nested: [{ [key]: "x" }] } }))).rejects.toThrow(
        /must not be logged/,
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  test("a blank reason is not stored", async () => {
    jest.spyOn(AuditLog, "create").mockImplementation(async ([doc]) => [doc]);
    const row = await audit.record(entry({ actor: admin, reason: "   " }));
    expect(row.reason).toBeUndefined();
  });
});

describe("toPageNumber", () => {
  test.each([
    [undefined, 1],
    ["", 1],
    ["0", 1],
    ["-3", 1],
    ["2.5", 1],
    ["abc", 1],
    ["1e3", 1],
    ["9999999", 1],
    ["3", 3],
    ["12", 12],
  ])("%p -> %p", (input, expected) => {
    expect(audit.toPageNumber(input)).toBe(expected);
  });

  test("an array or object (?page[]=2, ?page[a]=1) is page 1", () => {
    expect(audit.toPageNumber(["2"])).toBe(1);
    expect(audit.toPageNumber({ a: "1" })).toBe(1);
  });
});

describe("listAudit", () => {
  function stubFind(rows, total) {
    jest.spyOn(AuditLog, "countDocuments").mockResolvedValue(total);
    const query = {
      sort: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      populate: jest.fn(() => query),
      lean: jest.fn(async () => rows),
    };
    jest.spyOn(AuditLog, "find").mockReturnValue(query);
    return query;
  }

  test("newest first, one page at a time, never more than the page size", async () => {
    const query = stubFind([], 60);
    const out = await audit.listAudit({ page: "2" });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(query.skip).toHaveBeenCalledWith(audit.PAGE_SIZE);
    expect(query.limit).toHaveBeenCalledWith(audit.PAGE_SIZE);
    expect(out).toMatchObject({ page: 2, totalPages: 3, total: 60 });
  });

  test("a page past the end shows the last page; a bad value shows page 1", async () => {
    stubFind([], 30);
    expect((await audit.listAudit({ page: "99" })).page).toBe(2);
    expect((await audit.listAudit({ page: "x" })).page).toBe(1);
  });

  test("an empty log is one empty page", async () => {
    stubFind([], 0);
    expect(await audit.listAudit({})).toMatchObject({ page: 1, totalPages: 1, total: 0 });
  });
});
