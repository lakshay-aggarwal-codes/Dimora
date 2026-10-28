// P19-T02: `npm run seed:demo` against a real database (see tests/helpers/db.js).
// Runs the real services with a set-back clock, so these checks are about what
// the app itself would have written: ledger rows, refunds, ratings, history.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const User = require("../../src/models/user");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const { runSeed } = require("../../scripts/seed");
const { runDemoSeed, resetDemoData } = require("../../scripts/seed-demo");
const { DEMO_ACCOUNTS, SCENARIOS } = require("../../scripts/demo-data");
const { STATUSES, holdsNights } = require("../../src/services/stateMachine");

const countsByStatus = async () => {
  const out = {};
  for (const r of await Reservation.find({}, { status: 1 }).lean()) out[r.status] = (out[r.status] || 0) + 1;
  return out;
};

describeDb("seed:demo", () => {
  useTestDb();

  test("creates 4 accounts, 29 complete places and a booking in every state", async () => {
    const summary = await runDemoSeed();

    expect(Object.keys(summary.accounts).sort()).toEqual(["admin", "guest", "guest2", "host"]);
    const passwords = Object.values(summary.accounts).map((a) => a.password);
    for (const password of passwords) expect(password).toEqual(expect.any(String));
    expect(new Set(passwords).size).toBe(4); // never the same password twice
    expect((await User.findOne({ username: DEMO_ACCOUNTS.admin.username })).role).toBe("admin");
    for (const name of ["host", "guest", "guest2"]) {
      expect((await User.findOne({ username: DEMO_ACCOUNTS[name].username })).role).toBe("member");
    }

    const host = await User.findOne({ username: DEMO_ACCOUNTS.host.username });
    const listings = await Listing.find({});
    expect(listings).toHaveLength(29);
    for (const listing of listings) {
      expect(String(listing.owner)).toBe(String(host._id));
      expect(listing.status).toBe("published");
      expect(listing.images).toHaveLength(5);
      expect(listing.publicGeometry.coordinates).toHaveLength(2);
      expect(listing.validateSync()).toBeUndefined();
    }

    const byStatus = await countsByStatus();
    expect(Object.keys(byStatus).sort()).toEqual([...STATUSES].sort());
    expect(byStatus).toEqual({
      pending: 2,
      confirmed: 2,
      declined: 1,
      expired: 1,
      cancelled_by_guest: 1,
      cancelled_by_host: 1,
      completed: 6,
    });
    expect(summary.reservations.byStatus).toEqual(byStatus);
    expect(summary.reservations.problems).toEqual([]);
  });

  test("the night ledger matches the bookings exactly", async () => {
    await runDemoSeed();
    const rows = await StayNight.find({}).lean();
    const bySource = new Map();
    for (const row of rows) {
      expect(row.source.kind).toBe("reservation");
      bySource.set(String(row.source.id), [...(bySource.get(String(row.source.id)) || []), row]);
    }
    for (const reservation of await Reservation.find({}).lean()) {
      const held = bySource.get(String(reservation._id)) || [];
      if (holdsNights(reservation.status)) {
        expect(held).toHaveLength(reservation.nights);
        for (const row of held) {
          expect(String(row.listing)).toBe(String(reservation.listing));
          if (reservation.status === "pending") expect(row.holdExpiresAt).toBeInstanceOf(Date);
          else expect(row.holdExpiresAt).toBeUndefined();
        }
      } else {
        expect(held).toHaveLength(0);
      }
      bySource.delete(String(reservation._id));
    }
    expect(bySource.size).toBe(0); // no row without a reservation
  });

  test("bookings carry real snapshots, back-dated times and the host's answers", async () => {
    const now = new Date();
    await runDemoSeed({ now });
    for (const reservation of await Reservation.find({})) {
      expect(reservation.pricingSnapshot.totalMinor).toBeGreaterThan(0);
      expect(reservation.listingSnapshot.title).toBeTruthy();
      expect(reservation.createdAt.getTime()).toBeLessThan(now.getTime());
      expect(reservation.statusHistory.length).toBeGreaterThanOrEqual(1);
      expect(reservation.idempotencyKey).toMatch(/^demo-/);
    }

    const accepted = await Reservation.findOne({ idempotencyKey: "demo-g-confirmed-accepted" });
    expect(accepted.statusHistory.map((h) => [h.from, h.to, h.actor])).toEqual([
      [null, "pending", "guest"],
      ["pending", "confirmed", "host"],
    ]);
    expect(accepted.holdExpiresAt).toBeUndefined();

    const declined = await Reservation.findOne({ idempotencyKey: "demo-h-declined" });
    expect(declined.statusHistory.at(-1).note).toBe(SCENARIOS.find((s) => s.key === "h-declined").reason);

    const waiting = await Reservation.find({ status: "pending" });
    for (const reservation of waiting) expect(reservation.holdExpiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test("cancellations carry the refund the policy gives, and the host's counter goes up", async () => {
    await runDemoSeed();
    const byGuest = await Reservation.findOne({ idempotencyKey: "demo-g-cancelled-guest" });
    expect(byGuest.status).toBe("cancelled_by_guest");
    expect(byGuest.cancelledBy).toBe("guest");
    expect(byGuest.refund.retainedMinor).toBeGreaterThan(0); // inside the 5-day window of a moderate policy
    expect(byGuest.refund.amountMinor + byGuest.refund.retainedMinor).toBe(byGuest.refund.totalMinor);

    const byHost = await Reservation.findOne({ idempotencyKey: "demo-h-cancelled-host" });
    expect(byHost.status).toBe("cancelled_by_host");
    expect(byHost.refund.retainedMinor).toBe(0);
    expect(byHost.refund.amountMinor).toBe(byHost.refund.totalMinor);
    expect(byHost.cancelReason).toMatch(/refund/i);

    const host = await User.findOne({ username: DEMO_ACCOUNTS.host.username });
    expect(host.hostCancellationCount).toBe(1);
  });

  test("reviews sit on completed stays, are counted in the ratings and are dated after the stay", async () => {
    await runDemoSeed();
    const reviews = await Review.find({});
    expect(reviews).toHaveLength(SCENARIOS.filter((s) => s.review).length);
    for (const review of reviews) {
      const reservation = await Reservation.findById(review.reservation);
      expect(reservation.status).toBe("completed");
      expect(String(review.author)).toBe(String(reservation.guest));
      expect(review.legacy).toBe(false);
      expect(review.createdAt.getTime()).toBeGreaterThan(reservation.checkOut.getTime());
      expect(review.createdAt.getTime()).toBeLessThan(Date.now());
      const listing = await Listing.findById(review.listing);
      expect(listing.ratingCount).toBe(1);
      expect(listing.ratingAvg).toBe(review.rating);
      expect(listing.reviews.map(String)).toContain(String(review._id));
    }
    // a finished stay that can still be reviewed, and one that cannot
    expect(await Review.exists({ reservation: (await Reservation.findOne({ idempotencyKey: "demo-g-completed-reviewable" }))._id })).toBeNull();
    expect(await Review.exists({ reservation: (await Reservation.findOne({ idempotencyKey: "demo-g-completed-old" }))._id })).toBeNull();
  });

  test("running it again changes nothing and shows no passwords", async () => {
    await runDemoSeed();
    const before = {
      listings: await Listing.countDocuments({}),
      reservations: await Reservation.countDocuments({}),
      nights: await StayNight.countDocuments({}),
      reviews: await Review.countDocuments({}),
      users: await User.countDocuments({}),
      status: await countsByStatus(),
    };
    const second = await runDemoSeed();
    expect(second.listings).toEqual({ created: 0, updated: 29, total: 29 });
    expect(second.reservations.created).toBe(0);
    expect(second.reservations.reviewsCreated).toBe(0);
    expect(second.reservations.problems).toEqual([]);
    for (const account of Object.values(second.accounts)) expect(account.password).toBeNull();
    expect({
      listings: await Listing.countDocuments({}),
      reservations: await Reservation.countDocuments({}),
      nights: await StayNight.countDocuments({}),
      reviews: await Review.countDocuments({}),
      users: await User.countDocuments({}),
      status: await countsByStatus(),
    }).toEqual(before);
  });

  test("a bad run can be finished by running it again (an interrupted booking is driven on)", async () => {
    await runDemoSeed();
    // Put one booking back to the middle of its path, as an interrupted run would leave it.
    const reservation = await Reservation.findOne({ idempotencyKey: "demo-g-confirmed-accepted" });
    await Reservation.updateOne(
      { _id: reservation._id },
      { $set: { status: "pending", holdExpiresAt: new Date(Date.now() + 3600 * 1000) }, $pop: { statusHistory: 1 } },
    );
    await StayNight.updateMany({ "source.id": reservation._id }, { $set: { holdExpiresAt: new Date(Date.now() + 3600 * 1000) } });
    const again = await runDemoSeed();
    expect(again.reservations.problems).toEqual([]);
    expect((await Reservation.findById(reservation._id)).status).toBe("confirmed");
  });

  test("a night that is already taken is reported and the rest still goes in", async () => {
    await runDemoSeed();
    const pending = await Reservation.findOne({ idempotencyKey: "demo-g-pending" });
    await StayNight.deleteMany({ "source.id": pending._id });
    await Reservation.deleteOne({ _id: pending._id });
    await StayNight.create({
      listing: pending.listing,
      date: pending.checkIn,
      source: { kind: "block", id: new mongoose.Types.ObjectId() },
    });

    const again = await runDemoSeed();
    expect(again.reservations.problems).toHaveLength(1);
    expect(again.reservations.problems[0]).toMatch(/^g-pending: /);
    expect(await Reservation.countDocuments({})).toBe(13);
  });

  test("--rotate-passwords gives every account a new password and the old one stops working", async () => {
    const first = await runDemoSeed();
    const rotated = await runDemoSeed({ rotatePasswords: true });
    for (const [name, account] of Object.entries(rotated.accounts)) {
      expect(account.password).toEqual(expect.any(String));
      expect(account.password).not.toBe(first.accounts[name].password);
      const user = await User.findOne({ username: DEMO_ACCOUNTS[name].username });
      expect((await user.authenticate(account.password)).user).toBeTruthy();
      expect((await user.authenticate(first.accounts[name].password)).user).toBeFalsy();
    }
    expect(await Reservation.countDocuments({})).toBe(14); // nothing else changed
  });

  test("--reset removes the host's places and what hangs on them, then builds it again; nobody else's data moves", async () => {
    const { user: stranger } = await createUser({ username: "someone_else" });
    const theirs = await createListing({ owner: stranger._id, title: "Mountain Retreat" });
    await runDemoSeed();
    expect(await Listing.countDocuments({})).toBe(30);

    const again = await runDemoSeed({ reset: true });
    expect(again.removed).toBe(29);
    expect(again.listings).toEqual({ created: 29, updated: 0, total: 29 });
    expect(again.reservations.created).toBe(14);
    expect(again.reservations.reviewsCreated).toBe(4);
    expect(await Reservation.countDocuments({})).toBe(14);
    expect(await Review.countDocuments({})).toBe(4);
    expect(await StayNight.countDocuments({})).toBe(
      (await Reservation.find({ status: { $in: ["pending", "confirmed", "completed"] } }, { nights: 1 }).lean()).reduce((n, r) => n + r.nights, 0),
    );
    expect(await Listing.countDocuments({})).toBe(30);
    expect(await Listing.exists({ _id: theirs._id })).toBeTruthy();
    expect((await User.findOne({ username: DEMO_ACCOUNTS.host.username })).hostCancellationCount).toBe(1);
  });

  test("resetDemoData leaves no reservation, night, review or listing of the host behind", async () => {
    await runDemoSeed();
    const host = await User.findOne({ username: DEMO_ACCOUNTS.host.username });
    const { removed } = await resetDemoData(host);
    expect(removed).toBe(29);
    for (const model of [Listing, Reservation, StayNight, Review]) expect(await model.countDocuments({})).toBe(0);
    expect((await User.findById(host._id)).hostCancellationCount).toBe(0);
  });

  test("it upgrades places made by `npm run seed` in place instead of adding a second set", async () => {
    await runSeed();
    const summary = await runDemoSeed();
    expect(summary.listings).toEqual({ created: 0, updated: 29, total: 29 });
    expect(await Listing.countDocuments({})).toBe(29);
    expect(await User.countDocuments({ username: DEMO_ACCOUNTS.host.username })).toBe(1);
    expect((await Listing.findOne({ title: "Mountain Retreat" })).images).toHaveLength(5);
    expect(summary.accounts.host.password).toBeNull(); // the host already existed
  });

  test("it refuses to run when NODE_ENV is production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(runDemoSeed()).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(await Listing.countDocuments({})).toBe(0);
    expect(await User.countDocuments({})).toBe(0);
  });
});
