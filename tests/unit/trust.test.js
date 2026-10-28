// P12-T05: trust indicators, with fake models (no database).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  MIN_DECIDED,
  summariseRequests,
  responseFrom,
  buildTrust,
  loadTrust,
} = require("../../src/services/trust");

const req = (to, actor, from = "pending") => ({ statusHistory: [{ from: null, to: "pending", actor: "guest" }, { from, to, actor }] });
const instant = () => ({ statusHistory: [{ from: null, to: "confirmed", actor: "guest" }] });

test("a request answered by the host counts as answered, an expired one as unanswered", () => {
  const out = summariseRequests([
    req("confirmed", "host"),
    req("declined", "host"),
    req("expired", "system"),
  ]);
  assert.deepEqual(out, { answered: 2, expired: 1 });
});

test("withdrawn requests, instant bookings, waiting requests and odd rows are in neither count", () => {
  const out = summariseRequests([
    req("cancelled_by_guest", "guest"),
    instant(),
    { statusHistory: [{ from: null, to: "pending", actor: "guest" }] },
    { statusHistory: [] },
    {},
    null,
    // "confirmed" by someone who is not the host is not an answer.
    req("confirmed", "system"),
  ]);
  assert.deepEqual(out, { answered: 0, expired: 0 });
  assert.deepEqual(summariseRequests(undefined), { answered: 0, expired: 0 });
});

test("no percentage below the minimum number of decided requests", () => {
  assert.equal(MIN_DECIDED, 5);
  assert.equal(responseFrom({ answered: 4, expired: 0 }), null);
  assert.equal(responseFrom({ answered: 0, expired: 4 }), null);
  assert.equal(responseFrom({ answered: 0, expired: 0 }), null);
});

test("from the minimum on, the percentage is rounded and says how many requests it rests on", () => {
  assert.deepEqual(responseFrom({ answered: 5, expired: 0 }), { percent: 100, basedOn: 5 });
  assert.deepEqual(responseFrom({ answered: 2, expired: 3 }), { percent: 40, basedOn: 5 });
  assert.deepEqual(responseFrom({ answered: 2, expired: 1 + 3 }), { percent: 33, basedOn: 6 });
});

test("only facts that are true appear, in a fixed order", () => {
  const none = buildTrust({ emailConfirmed: false, memberSince: "", stats: null });
  assert.deepEqual(none.items, []);

  const some = buildTrust({ emailConfirmed: false, memberSince: "March 2026", stats: { staysHosted: 0, answered: 1, expired: 0 } });
  assert.deepEqual(some.items.map((i) => i.key), ["since"]);

  const all = buildTrust({ emailConfirmed: true, memberSince: "March 2026", stats: { staysHosted: 1, answered: 4, expired: 1 } });
  assert.deepEqual(all.items.map((i) => i.key), ["email", "since", "stays", "response"]);
  assert.equal(all.items[2].text, "1 stay hosted");
  assert.match(all.items[3].text, /80% of booking requests in the last 12 months \(5 requests\)/);
  assert.equal(buildTrust({ emailConfirmed: true, memberSince: "x", stats: { staysHosted: 3, answered: 0, expired: 0 } }).items[2].text, "3 stays hosted");
});

test("an unconfirmed member is never shown as 'not verified'", () => {
  const t = buildTrust({ emailConfirmed: false, memberSince: "March 2026" });
  assert.equal(JSON.stringify(t).toLowerCase().includes("not "), false);
});

function fakeModels({ user, completed = 0, requests = [] }) {
  const calls = { count: [], find: [] };
  const chain = (rows) => ({ sort: () => chain(rows), limit: () => chain(rows), select: () => chain(rows), lean: async () => rows });
  return {
    calls,
    User: { findById: () => ({ select: () => ({ lean: async () => user }) }) },
    Reservation: {
      countDocuments: async (f) => (calls.count.push(f), completed),
      find: (f) => (calls.find.push(f), chain(requests)),
    },
  };
}
const ID = "64b0000000000000000000a1";
const NOW = new Date("2026-10-28T10:00:00Z");

test("loadTrust reads the stays and the last 12 months of requests of that host", async () => {
  const user = { _id: ID, createdAt: new Date("2026-03-10T00:00:00Z"), emailVerifiedAt: new Date() };
  const m = fakeModels({ user, completed: 2, requests: [req("confirmed", "host"), req("confirmed", "host"), req("confirmed", "host"), req("expired", "system"), req("declined", "host")] });
  const t = await loadTrust(m, user, { now: NOW, isReady: () => true });
  assert.equal(t.staysHosted, 2);
  assert.deepEqual(t.response, { percent: 80, basedOn: 5 });
  assert.equal(t.memberSince, "March 2026");
  assert.deepEqual(m.calls.count[0], { host: ID, status: "completed" });
  assert.equal(m.calls.find[0].host, ID);
  assert.equal(m.calls.find[0].createdAt.$gte.toISOString(), "2025-10-28T10:00:00.000Z");
});

test("without a database the facts on the user still show and nothing is counted", async () => {
  const user = { _id: ID, createdAt: new Date("2026-03-10T00:00:00Z"), emailVerifiedAt: new Date() };
  const m = fakeModels({ user, completed: 9 });
  const t = await loadTrust(m, user, { isReady: () => false });
  assert.deepEqual(t.items.map((i) => i.key), ["email", "since"]);
  assert.equal(m.calls.count.length, 0);
});

test("an id is looked up; an unknown or invalid id gives null", async () => {
  const user = { _id: ID, createdAt: new Date("2026-03-10T00:00:00Z"), emailVerifiedAt: null };
  const found = await loadTrust(fakeModels({ user }), ID, { isReady: () => true });
  assert.deepEqual(found.items.map((i) => i.key), ["since"]);
  assert.equal(await loadTrust(fakeModels({ user: null }), ID, { isReady: () => true }), null);
  assert.equal(await loadTrust(fakeModels({ user }), "nope", { isReady: () => true }), null);
});

// The copy review of P12-T05, kept as a test: no page may claim a check the site does not do.
test("no view or email text makes a verification, vetting or badge claim", () => {
  const BANNED = [
    /verified (host|member|user|guest|account|profile)/i,
    /\b(superhost|super host)\b/i,
    /(trusted|trustworthy|vetted|certified|top[- ]rated) (host|member|user|guest)/i,
    /identity (verified|checked|confirmed)/i,
    /background[- ]check/i,
    /id[- ]verified/i,
  ];
  const roots = [path.join(__dirname, "..", "..", "views"), path.join(__dirname, "..", "..", "src", "emails")];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ejs|js)$/.test(entry.name)) files.push(full);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of BANNED) assert.equal(pattern.test(text), false, `${path.basename(file)} matches ${pattern}`);
  }
});
