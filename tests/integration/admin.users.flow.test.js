// P14-T02 without a database: the real router, guard, wrapper, controller and
// service together in a small Express app, with the models and the audit write
// stubbed. Shows the wiring: one audit row per accepted action, none for a
// refusal, and that the target's sessions really leave the store.
const express = require("express");
const request = require("supertest");
const session = require("express-session");
const { ObjectId } = require("mongoose").Types;
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const audit = require("../../src/services/audit");
const adminRouter = require("../../src/routes/admin");

afterEach(() => jest.restoreAllMocks());

const boss = { _id: new ObjectId(), username: "boss", role: "admin", status: "active" };
const chain = (value) => {
  const c = {};
  for (const m of ["select", "sort", "skip", "limit", "lean", "populate"]) c[m] = () => c;
  c.then = (res, rej) => Promise.resolve(value).then(res, rej);
  return c;
};

function setup(user = boss) {
  const store = new session.MemoryStore();
  store.sessions.s1 = JSON.stringify({ cookie: {}, passport: { user: "ann" } });
  store.sessions.s2 = JSON.stringify({ cookie: {}, passport: { user: "bob" } });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = user;
    req.id = "req-1";
    req.sessionStore = store;
    req.flash = jest.fn();
    res.render = (view) => res.status(200).send(`rendered ${view}`);
    next();
  });
  app.use("/admin", adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).send(err.message));
  return { app, store };
}

function stubModels(target) {
  jest
    .spyOn(User, "findById")
    .mockImplementation((id) => chain(String(id) === String(boss._id) ? boss : target));
  jest.spyOn(User, "countDocuments").mockResolvedValue(2);
  jest.spyOn(User, "updateOne").mockResolvedValue({ modifiedCount: 1 });
  jest.spyOn(Listing, "updateMany").mockResolvedValue({ modifiedCount: 2 });
  return jest.spyOn(audit, "record").mockImplementation(async ({ req }) => {
    req.auditRecorded = (req.auditRecorded || 0) + 1;
  });
}

test("suspend: redirects, deletes only the target's sessions, writes exactly one audit row", async () => {
  const target = { _id: new ObjectId(), username: "ann", role: "member", status: "active" };
  const record = stubModels(target);
  const { app, store } = setup();

  const res = await request(app).post(`/admin/users/${target._id}/suspend`).type("form").send({ reason: "repeated fake listings" });

  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`/admin/users/${target._id}`);
  expect(Object.keys(store.sessions)).toEqual(["s2"]);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({
    action: "user.suspend",
    targetType: "user",
    targetId: target._id,
    reason: "repeated fake listings",
    details: { listingsHidden: 2, sessionsDeleted: 1 },
  });
});

test("refusals redirect back with no audit row and no change", async () => {
  const target = { _id: new ObjectId(), username: "ann", role: "member", status: "active" };
  const record = stubModels(target);
  const { app, store } = setup();

  for (const body of [{}, { reason: "no" }]) {
    const res = await request(app).post(`/admin/users/${target._id}/suspend`).type("form").send(body);
    expect(res.status).toBe(302);
  }
  const self = await request(app).post(`/admin/users/${boss._id}/suspend`).type("form").send({ reason: "testing it out" });
  expect(self.status).toBe(302);

  expect(record).not.toHaveBeenCalled();
  expect(User.updateOne).not.toHaveBeenCalled();
  expect(Object.keys(store.sessions).sort()).toEqual(["s1", "s2"]);
});

test("reinstate writes one audit row", async () => {
  const target = { _id: new ObjectId(), username: "ann", role: "member", status: "suspended" };
  const record = stubModels(target);
  const res = await request(setup().app).post(`/admin/users/${target._id}/reinstate`).type("form").send({ reason: "appeal accepted" });
  expect(res.status).toBe(302);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({ action: "user.reinstate", reason: "appeal accepted" });
});

test("a member cannot reach any of it, and nothing is stubbed-called", async () => {
  const record = stubModels({ _id: new ObjectId(), username: "ann", role: "member", status: "active" });
  const { app } = setup({ _id: new ObjectId(), username: "mem", role: "member", status: "active" });
  for (const [method, url] of [
    ["get", "/admin/users"],
    ["get", `/admin/users/${new ObjectId()}`],
    ["post", `/admin/users/${new ObjectId()}/suspend`],
    ["post", `/admin/users/${new ObjectId()}/reinstate`],
  ]) {
    expect((await request(app)[method](url).type("form").send({ reason: "spam listings" })).status).toBe(404);
  }
  expect(record).not.toHaveBeenCalled();
  expect(User.updateOne).not.toHaveBeenCalled();
});
