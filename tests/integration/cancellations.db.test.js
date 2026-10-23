// P09-T03 against a real MongoDB: the cancel flows with the real models, the
// refund stored by the same update that cancels, the host counter, races
// between real parallel requests. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/cancellations.db.test.js
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const ledger = require("../../src/services/ledger");
const { cancelBooking } = require("../../src/services/cancellations");
const { loadPublicProfile } = require("../../src/services/profile");
const { eachNight, parseDateOnly } = require("../../src/utils/dates");

const DAY = 24 * 3600000;
const NOW = new Date("2026-11-20T06:00:00.000Z");
const day = (s) => parseDateOnly(s);
let keyN = 0;

describeDb("cancellations (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init()]);
  });

  async function world() {
    const hostUser = await createUser();
    const guestUser = await createUser();
    const listing = await createListing({ owner: hostUser.user });
    return { host: hostUser.user, guest: guestUser.user, listing };
  }

  async function reserve(
    { host, guest, listing },
    {
      status = "confirmed",
      checkIn = "2026-12-10",
      checkOut = "2026-12-13",
      policy = "flexible",
    } = {},
  ) {
    const _id = new mongoose.Types.ObjectId();
    const nights = eachNight(day(checkIn), day(checkOut));
    await ledger.reserveNights(
      listing._id,
      nights,
      { kind: "reservation", id: _id },
      status === "pending" ? new Date(NOW.getTime() + DAY) : null,
      { now: NOW },
    );
    return Reservation.create({
      _id,
      listing: listing._id,
      guest: guest._id,
      host: host._id,
      checkIn: day(checkIn),
      checkOut: day(checkOut),
      nights: nights.length,
      guests: 2,
      status,
      ...(status === "pending"
        ? { holdExpiresAt: new Date(NOW.getTime() + DAY) }
        : {}),
      statusHistory: [
        {
          from: null,
          to: status,
          at: new Date("2026-11-01T00:00:00Z"),
          actor: "guest",
        },
      ],
      pricingSnapshot: {
        totalMinor: 800000,
        subtotalMinor: 750000,
        avgPerNightMinor: 250000,
        currency: "INR",
      },
      listingSnapshot: {
        title: "Sea house",
        timezone: "Asia/Kolkata",
        checkInTime: "14:00",
        cancellationPolicy: policy,
      },
      idempotencyKey: `cancel-key-${(keyN += 1)}-abcdefgh`,
    });
  }

  const cancel = (id, user, reason, now = NOW) =>
    cancelBooking({}, { id: String(id), user, reason, now });

  test("the guest cancels: the refund is stored with the status, the nights are free again", async () => {
    const w = await world();
    const r = await reserve(w);
    await cancel(r._id, w.guest, "Plans changed");
    const stored = await Reservation.findById(r._id).lean();
    expect(stored.status).toBe("cancelled_by_guest");
    expect(stored.cancelledBy).toBe("guest");
    expect(stored.cancelReason).toBe("Plans changed");
    expect(stored.refund).toEqual(
      expect.objectContaining({
        amountMinor: 800000,
        retainedMinor: 0,
        totalMinor: 800000,
        currency: "INR",
        policy: "flexible",
        rule: "flexible_free",
      }),
    );
    expect(stored.refund.calculatedAt).toEqual(NOW);
    expect(await StayNight.countDocuments()).toBe(0);
    expect(await checkDatabase()).toEqual([]);
    // the freed nights can be booked by somebody else
    const again = await ledger.reserveNights(
      w.listing._id,
      eachNight(day("2026-12-10"), day("2026-12-13")),
      { kind: "reservation", id: new mongoose.Types.ObjectId() },
      null,
      { now: NOW },
    );
    expect(again).toBeDefined();
  });

  test("a late cancellation records the partial refund", async () => {
    const w = await world();
    const r = await reserve(w, { policy: "moderate" });
    await cancel(
      r._id,
      w.guest,
      undefined,
      new Date(day("2026-12-10").getTime() - 2 * DAY),
    );
    const stored = await Reservation.findById(r._id).lean();
    expect(stored.refund).toEqual(
      expect.objectContaining({
        amountMinor: 300000,
        retainedMinor: 500000,
        rule: "moderate_late",
      }),
    );
  });

  test("the host cancels: full refund, reason kept, the real counter goes up by one", async () => {
    const w = await world();
    const r = await reserve(w, { policy: "strict" });
    await cancel(
      r._id,
      w.host,
      "Pipe burst",
      new Date(day("2026-12-10").getTime() - 3600000),
    );
    const stored = await Reservation.findById(r._id).lean();
    expect(stored.status).toBe("cancelled_by_host");
    expect(stored.refund).toEqual(
      expect.objectContaining({ amountMinor: 800000, rule: "host_cancelled" }),
    );
    expect((await User.findById(w.host._id).lean()).hostCancellationCount).toBe(
      1,
    );
    expect(await StayNight.countDocuments()).toBe(0);
    expect(await checkDatabase()).toEqual([]);

    const profile = await loadPublicProfile(
      { User, Listing, Review },
      String(w.host._id),
    );
    expect(profile.hostCancellationCount).toBe(1);
  });

  test("a user who never cancelled has a counter of zero", async () => {
    const w = await world();
    expect(
      (await User.findById(w.host._id).lean()).hostCancellationCount ?? 0,
    ).toBe(0);
  });

  test("8 parallel host cancellations: one wins, the counter goes up exactly once", async () => {
    const w = await world();
    const r = await reserve(w);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => cancel(r._id, w.host, "Sorry")),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await User.findById(w.host._id).lean()).hostCancellationCount).toBe(
      1,
    );
    const stored = await Reservation.findById(r._id).lean();
    expect(
      stored.statusHistory.filter((h) => h.to === "cancelled_by_host"),
    ).toHaveLength(1);
    expect(await checkDatabase()).toEqual([]);
  });

  test("guest and host cancel at the same moment: one winner, one refund record, consistent ledger", async () => {
    const w = await world();
    const r = await reserve(w, { policy: "strict" });
    const nearly = new Date(day("2026-12-10").getTime() - 3600000);
    const results = await Promise.allSettled([
      cancel(r._id, w.guest, "g", nearly),
      cancel(r._id, w.host, "h", nearly),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const stored = await Reservation.findById(r._id).lean();
    if (stored.status === "cancelled_by_host") {
      expect(stored.refund.amountMinor).toBe(800000);
      expect(
        (await User.findById(w.host._id).lean()).hostCancellationCount,
      ).toBe(1);
    } else {
      expect(stored.status).toBe("cancelled_by_guest");
      expect(stored.refund.amountMinor).toBe(0);
      expect(
        (await User.findById(w.host._id).lean()).hostCancellationCount ?? 0,
      ).toBe(0);
    }
    expect(await checkDatabase()).toEqual([]);
  });

  test("a withdrawn request is free, and its nights are released", async () => {
    const w = await world();
    const r = await reserve(w, { status: "pending", policy: "strict" });
    await cancel(r._id, w.guest);
    const stored = await Reservation.findById(r._id).lean();
    expect(stored.refund).toEqual(
      expect.objectContaining({
        amountMinor: 800000,
        rule: "request_withdrawn",
      }),
    );
    expect(stored.holdExpiresAt).toBeUndefined();
    expect(await StayNight.countDocuments()).toBe(0);
  });

  test("strangers and finished stays are refused and nothing changes", async () => {
    const w = await world();
    const r = await reserve(w);
    const { user: stranger } = await createUser();
    await expect(cancel(r._id, stranger, "x")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      cancel(r._id, w.guest, undefined, new Date("2026-12-14T00:00:00Z")),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await Reservation.findById(r._id)).status).toBe("confirmed");
    expect(await StayNight.countDocuments()).toBe(3);
  });
});
