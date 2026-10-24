// P14-T03 without a database: the real admin router, guard, audit wrapper,
// controller and moderation service in a small Express app, with the models and
// the audit write stubbed. Shows the wiring: one audit row per accepted action,
// none for a refusal, and that only admins reach any of it.
const express = require("express");
const request = require("supertest");
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const Report = require("../../src/models/report");
const AuditLog = require("../../src/models/auditLog");
const audit = require("../../src/services/audit");
const adminRouter = require("../../src/routes/admin");

afterEach(() => jest.restoreAllMocks());

const boss = {
  _id: new ObjectId(),
  username: "boss",
  role: "admin",
  status: "active",
};
const member = {
  _id: new ObjectId(),
  username: "ann",
  role: "member",
  status: "active",
};
const chain = (value) => {
  const c = {};
  for (const m of ["select", "sort", "skip", "limit", "lean", "populate"])
    c[m] = () => c;
  c.then = (res, rej) => Promise.resolve(value).then(res, rej);
  return c;
};

function setup(user = boss) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => {
    req.user = user;
    req.id = "req-1";
    req.flash = (type, message) => flashes.push([type, message]);
    res.render = (view, locals) =>
      res
        .status(200)
        .json({ view, locals: JSON.parse(JSON.stringify(locals)) });
    next();
  });
  app.use("/admin", adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) =>
    res.status(err.statusCode || 500).send(err.message),
  );
  return { app, flashes };
}

const published = () => ({
  _id: new ObjectId(),
  title: "Sea house",
  status: "published",
  deletedAt: null,
  owner: new ObjectId(),
});

function stub(doc, { modified = 1 } = {}) {
  jest.spyOn(Listing, "findById").mockImplementation(() => chain(doc));
  const update = jest
    .spyOn(Listing, "updateOne")
    .mockResolvedValue({ modifiedCount: modified });
  const record = jest
    .spyOn(audit, "record")
    .mockImplementation(async ({ req }) => {
      req.auditRecorded = (req.auditRecorded || 0) + 1;
    });
  return { update, record };
}

test("suspend: redirects to the listing, changes it once, writes exactly one audit row", async () => {
  const doc = published();
  const { update, record } = stub(doc);
  const { app, flashes } = setup();
  const res = await request(app)
    .post(`/admin/listings/${doc._id}/suspend`)
    .type("form")
    .send({ reason: "Photos are of another place" });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`/admin/listings/${doc._id}`);
  expect(update).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({
    action: "listing.suspend",
    targetType: "listing",
    targetId: doc._id,
    reason: "Photos are of another place",
    details: { title: "Sea house", from: "published", to: "suspended" },
  });
  expect(flashes[0]).toEqual([
    "success",
    expect.stringContaining("is suspended"),
  ]);
});

test("restore and mark reviewed each write one audit row with their own action", async () => {
  const suspended = { ...published(), status: "suspended" };
  let s = stub(suspended);
  let { app } = setup();
  await request(app)
    .post(`/admin/listings/${suspended._id}/restore`)
    .type("form")
    .send({ reason: "Photos replaced" });
  expect(s.record.mock.calls[0][0]).toMatchObject({
    action: "listing.restore",
    targetType: "listing",
    reason: "Photos replaced",
  });
  jest.restoreAllMocks();

  const doc = published();
  s = stub(doc);
  ({ app } = setup());
  const res = await request(app)
    .post(`/admin/listings/${doc._id}/reviewed`)
    .type("form")
    .send({});
  expect(res.status).toBe(302);
  expect(s.record).toHaveBeenCalledTimes(1);
  expect(s.record.mock.calls[0][0]).toMatchObject({
    action: "listing.review",
    targetType: "listing",
  });
  expect(s.record.mock.calls[0][0].reason).toBeUndefined();
});

test("refusals redirect back with the message, no audit row and no change", async () => {
  const doc = published();
  const { update, record } = stub(doc);
  const { app, flashes } = setup();
  for (const body of [{}, { reason: "no" }]) {
    const res = await request(app)
      .post(`/admin/listings/${doc._id}/suspend`)
      .type("form")
      .send(body);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/listings/${doc._id}`);
  }
  const bad = await request(app)
    .post("/admin/listings/not-an-id/suspend")
    .type("form")
    .send({ reason: "a good enough reason" });
  expect(bad.headers.location).toBe("/admin/listings");
  const restore = await request(app)
    .post(`/admin/listings/${doc._id}/restore`)
    .type("form")
    .send({ reason: "a good enough reason" });
  expect(restore.status).toBe(302);
  expect(flashes.every(([type]) => type === "error")).toBe(true);
  expect(flashes.at(-1)[1]).toMatch(/not suspended/);
  expect(record).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("a lost race is a refusal too, not a half-logged success", async () => {
  const doc = published();
  const { record } = stub(doc, { modified: 0 });
  const { app, flashes } = setup();
  const res = await request(app)
    .post(`/admin/listings/${doc._id}/suspend`)
    .type("form")
    .send({ reason: "a good enough reason" });
  expect(res.status).toBe(302);
  expect(flashes[0][1]).toMatch(/changed while you were suspending/);
  expect(record).not.toHaveBeenCalled();
});

test("the queue and the listing page render with their data", async () => {
  jest.spyOn(Listing, "countDocuments").mockResolvedValue(0);
  jest.spyOn(Listing, "find").mockReturnValue(chain([]));
  jest.spyOn(Report, "aggregate").mockResolvedValue([]);
  const { app } = setup();
  const queue = await request(app).get("/admin/listings?filter=new");
  expect(queue.status).toBe(200);
  expect(queue.body.view).toBe("admin/listings");
  expect(queue.body.locals.result).toEqual(
    expect.objectContaining({ filter: "new", total: 0, rows: [] }),
  );

  const doc = published();
  jest.spyOn(Listing, "findById").mockReturnValue(chain(doc));
  jest.spyOn(Report, "find").mockReturnValue(chain([]));
  jest.spyOn(AuditLog, "find").mockReturnValue(chain([]));
  const page = await request(app).get(`/admin/listings/${doc._id}`);
  expect(page.body.view).toBe("admin/listing");
  expect(page.body.locals.page.summary.title).toBe("Sea house");
  jest.restoreAllMocks();
  jest.spyOn(Listing, "findById").mockReturnValue(chain(null));
  expect(
    (await request(app).get(`/admin/listings/${new ObjectId()}`)).status,
  ).toBe(404);
  expect((await request(app).get("/admin/listings/nope")).status).toBe(404);
});

test("members and visitors get the same 404 for every moderation route, and nothing is touched", async () => {
  const { update, record } = stub(published());
  for (const user of [member, null]) {
    const { app } = setup(user);
    const id = new ObjectId();
    for (const [method, path] of [
      ["get", "/admin/listings"],
      ["get", `/admin/listings/${id}`],
      ["post", `/admin/listings/${id}/suspend`],
      ["post", `/admin/listings/${id}/restore`],
      ["post", `/admin/listings/${id}/reviewed`],
    ]) {
      const agent = request(app);
      const res = await agent[method](path)
        .type("form")
        .send({ reason: "a good enough reason" });
      expect(res.status).toBe(404);
    }
  }
  expect(update).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});
