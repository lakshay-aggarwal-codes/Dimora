// P12-T05 against a real MongoDB and the real app: what the profile page and the
// listing page show about a host. Needs a MongoDB; skipped with SKIP_DB_TESTS=1.
const assert = require("node:assert/strict");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const User = require("../../src/models/user");
const Reservation = require("../../src/models/reservation");

const history = (to, actor) => [
  { from: null, to: "pending", actor: "guest", at: new Date() },
  { from: "pending", to, actor, at: new Date() },
];

// Raw inserts: only the fields the indicators read.
async function addReservations(host, rows) {
  const guest = (await createUser()).user;
  await Reservation.collection.insertMany(
    rows.map((r, i) => ({
      host: host._id,
      guest: guest._id,
      listing: host._id,
      status: r.status,
      statusHistory: r.history || [],
      createdAt: r.createdAt || new Date(),
      idempotencyKey: `key-${host._id}-${i}-${Math.random()}`,
    })),
  );
}

describeDb("trust indicators (database)", () => {
  useTestDb();

  test("a new member shows member-since only: no counts, no percentage, no email claim", async () => {
    const { user } = await createUser();
    const res = await createAgent().get(`/users/${user._id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /data-trust-item="since"/);
    for (const key of ["email", "stays", "response"]) assert.equal(res.text.includes(`data-trust-item="${key}"`), false, key);
    assert.equal(res.text.includes("data-trust-note"), false);
  });

  test("a confirmed host with completed stays and enough decided requests shows all four", async () => {
    const { user } = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    await addReservations(user, [
      { status: "completed", history: history("confirmed", "host") },
      { status: "completed", history: history("confirmed", "host") },
      { status: "confirmed", history: history("confirmed", "host") },
      { status: "declined", history: history("declined", "host") },
      { status: "expired", history: history("expired", "system") },
    ]);
    const res = await createAgent().get(`/users/${user._id}`);
    for (const key of ["email", "since", "stays", "response"]) assert.ok(res.text.includes(`data-trust-item="${key}"`), key);
    assert.match(res.text, /2 stays hosted/);
    assert.match(res.text, /Answered 80% of booking requests/);
    assert.match(res.text, /does not check anyone's identity/);
  });

  test("four decided requests are not enough for a percentage", async () => {
    const { user } = await createUser();
    await addReservations(user, [
      { status: "expired", history: history("expired", "system") },
      { status: "expired", history: history("expired", "system") },
      { status: "expired", history: history("expired", "system") },
      { status: "declined", history: history("declined", "host") },
    ]);
    const res = await createAgent().get(`/users/${user._id}`);
    assert.equal(res.text.includes('data-trust-item="response"'), false);
  });

  test("requests older than 12 months do not count, and other hosts' requests do not leak in", async () => {
    const { user } = await createUser();
    const other = (await createUser()).user;
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await addReservations(user, Array.from({ length: 5 }, () => ({ status: "expired", history: history("expired", "system"), createdAt: old })));
    await addReservations(other, Array.from({ length: 5 }, () => ({ status: "expired", history: history("expired", "system") })));
    const res = await createAgent().get(`/users/${user._id}`);
    assert.equal(res.text.includes('data-trust-item="response"'), false);
  });

  test("the listing page shows the host's facts and never an unconfirmed claim", async () => {
    const { user } = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    const listing = await createListing({ owner: user });
    const res = await createAgent().get(`/listings/${listing._id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /data-trust-item="email"/);
    assert.match(res.text, /Email address confirmed/);

    const { user: plain } = await createUser();
    const l2 = await createListing({ owner: plain });
    const res2 = await createAgent().get(`/listings/${l2._id}`);
    assert.equal(res2.text.includes("Email address confirmed"), false);
  });

  test("the pages carry no verification badge wording", async () => {
    const { user } = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    const listing = await createListing({ owner: user });
    for (const url of [`/users/${user._id}`, `/listings/${listing._id}`]) {
      const res = await createAgent().get(url);
      assert.equal(/verified host|superhost|trusted host|identity verified/i.test(res.text), false, url);
    }
  });
});
