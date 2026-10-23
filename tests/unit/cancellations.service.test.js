// P09-T03: the guest's and the host's cancel flows over in-memory fakes with an
// injected clock. Races, who may cancel, the refund stored with the status,
// the host counter. A real database: tests/integration/cancellations.db.test.js.
const { createReservationService } = require("../../src/services/reservations");
const {
  cancelBooking,
  cancelOffer,
  mayCancel,
} = require("../../src/services/cancellations");
const pricing = require("../../src/services/pricing");
const {
  SweeperReservationModel,
  StampedLedger,
  fakeId,
} = require("../helpers/fakeSweeperDeps");
const { FakeListingModel } = require("../helpers/fakeReservationDeps");
const { findViolations } = require("../helpers/invariants");
const { parseDateOnly } = require("../../src/utils/dates");
const { formatMoney } = require("../../src/utils/money");
const {
  ConflictError,
  NotFoundError,
  ValidationError,
} = require("../../src/utils/errors");

const DAY = 24 * 3600000;
const T0 = new Date("2026-11-20T06:00:00.000Z");
const CHECK_IN = "2026-12-10"; // 14:00 Kolkata = 2026-12-10T08:30Z
const day = (s) => parseDateOnly(s);

function setup({ counterFails = false } = {}) {
  const Reservation = new SweeperReservationModel();
  const ledger = new StampedLedger(() => T0);
  const service = createReservationService({
    ReservationModel: Reservation,
    ListingModel: new FakeListingModel([]),
    ledgerService: ledger,
    pricing,
    newId: fakeId,
  });
  const UserModel = {
    updates: [],
    updateOne: jest.fn(async (filter, update) => {
      if (counterFails) throw new Error("db down");
      UserModel.updates.push([filter, update]);
      return { modifiedCount: 1 };
    }),
  };
  const logger = { error: jest.fn() };
  const guest = { _id: fakeId(), role: "member", status: "active" };
  const host = { _id: fakeId(), role: "member", status: "active" };
  const stranger = { _id: fakeId(), role: "member", status: "active" };
  const admin = { _id: fakeId(), role: "admin", status: "active" };

  function add({
    status = "confirmed",
    checkIn = CHECK_IN,
    checkOut = "2026-12-13",
    policy = "flexible",
    createdAt = new Date("2026-11-01T00:00:00Z"),
    hold,
  } = {}) {
    const _id = fakeId();
    const listing = fakeId();
    const doc = {
      _id,
      listing,
      guest: guest._id,
      host: host._id,
      checkIn: day(checkIn),
      checkOut: day(checkOut),
      nights: 3,
      guests: 2,
      status,
      createdAt,
      listingSnapshot: {
        timezone: "Asia/Kolkata",
        checkInTime: "14:00",
        cancellationPolicy: policy,
      },
      pricingSnapshot: {
        totalMinor: 800000,
        subtotalMinor: 750000,
        avgPerNightMinor: 250000,
        currency: "INR",
      },
      statusHistory: [
        { from: null, to: status, at: createdAt, actor: "guest" },
      ],
      ...(status === "pending"
        ? { holdExpiresAt: hold || new Date(T0.getTime() + DAY) }
        : {}),
    };
    Reservation.docs.push(doc);
    if (status === "pending" || status === "confirmed") {
      for (
        let t = doc.checkIn.getTime();
        t < doc.checkOut.getTime();
        t += DAY
      ) {
        const date = new Date();
        date.setTime(t);
        ledger.rows.push({
          _id: fakeId(),
          listing,
          date,
          source: { kind: "reservation", id: _id },
          createdAt,
        });
      }
    }
    return doc;
  }

  const cancel = (id, user, reason, now = T0) =>
    cancelBooking(
      {
        ReservationModel: Reservation,
        UserModel,
        reservationService: service,
        logger,
      },
      { id, user, reason, now },
    );

  return {
    Reservation,
    ledger,
    UserModel,
    logger,
    guest,
    host,
    stranger,
    admin,
    add,
    cancel,
    doc: (d) => Reservation.docs.find((x) => x._id === d._id),
  };
}

const consistent = (c) =>
  expect(findViolations(c.Reservation.docs, c.ledger.rows)).toEqual([]);

describe("the guest cancels", () => {
  test("a confirmed booking far ahead: full refund recorded with the status, nights released", async () => {
    const c = setup();
    const b = c.add();
    const out = await c.cancel(b._id, c.guest, "  Plans changed  ");
    expect(out.actor).toBe("guest");
    const stored = c.doc(b);
    expect(stored.status).toBe("cancelled_by_guest");
    expect(stored.cancelledBy).toBe("guest");
    expect(stored.cancelReason).toBe("Plans changed");
    expect(stored.refund).toEqual({
      amountMinor: 800000,
      retainedMinor: 0,
      totalMinor: 800000,
      currency: "INR",
      policy: "flexible",
      rule: "flexible_free",
      calculatedAt: T0,
    });
    expect(stored.statusHistory.at(-1)).toEqual(
      expect.objectContaining({
        from: "confirmed",
        to: "cancelled_by_guest",
        actor: "guest",
        note: "Plans changed",
      }),
    );
    expect(c.ledger.rows).toHaveLength(0);
    expect(c.UserModel.updateOne).not.toHaveBeenCalled(); // the host counter is for host cancellations
    consistent(c);
  });

  test("late cancellation: the policy's partial refund is recorded", async () => {
    const c = setup();
    const b = c.add({ policy: "moderate" });
    await c.cancel(
      b._id,
      c.guest,
      undefined,
      new Date(day(CHECK_IN).getTime() - 2 * DAY),
    );
    expect(c.doc(b).refund).toEqual(
      expect.objectContaining({
        amountMinor: 300000,
        retainedMinor: 500000,
        rule: "moderate_late",
      }),
    );
    expect(c.doc(b).cancelReason).toBeUndefined();
  });

  test("a pending request: free, whatever the policy, and its hold is gone", async () => {
    const c = setup();
    const b = c.add({ status: "pending", policy: "strict" });
    await c.cancel(b._id, c.guest);
    expect(c.doc(b).status).toBe("cancelled_by_guest");
    expect(c.doc(b).refund).toEqual(
      expect.objectContaining({
        amountMinor: 800000,
        rule: "request_withdrawn",
      }),
    );
    expect(c.doc(b).holdExpiresAt).toBeUndefined();
    expect(c.ledger.rows).toHaveLength(0);
    consistent(c);
  });

  test("a booking whose stay has started: allowed, nothing refunded", async () => {
    const c = setup();
    const b = c.add();
    await c.cancel(b._id, c.guest, undefined, new Date("2026-12-11T10:00:00Z"));
    expect(c.doc(b).refund).toEqual(
      expect.objectContaining({
        amountMinor: 0,
        retainedMinor: 800000,
        rule: "stay_started",
      }),
    );
  });

  test("once the stay is over it cannot be cancelled (409), and nothing changes", async () => {
    const c = setup();
    const b = c.add();
    await expect(
      c.cancel(b._id, c.guest, undefined, new Date("2026-12-13T06:00:00Z")),
    ).rejects.toMatchObject({ statusCode: 409, code: "not_cancellable" });
    expect(c.doc(b).status).toBe("confirmed");
    expect(c.ledger.rows).toHaveLength(3);
  });

  test.each([
    "cancelled_by_guest",
    "cancelled_by_host",
    "declined",
    "expired",
    "completed",
  ])("a %s booking cannot be cancelled again", async (status) => {
    const c = setup();
    const b = c.add({ status });
    await expect(c.cancel(b._id, c.guest)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(c.doc(b).status).toBe(status);
  });
});

describe("the host cancels", () => {
  test("a confirmed booking: guest refunded in full, reason kept, counter +1, nights released", async () => {
    const c = setup();
    const b = c.add({ policy: "strict" });
    const nearly = new Date(day(CHECK_IN).getTime() - 3600000);
    const out = await c.cancel(b._id, c.host, "Pipe burst", nearly);
    expect(out.actor).toBe("host");
    const stored = c.doc(b);
    expect(stored.status).toBe("cancelled_by_host");
    expect(stored.cancelledBy).toBe("host");
    expect(stored.cancelReason).toBe("Pipe burst");
    expect(stored.refund).toEqual(
      expect.objectContaining({
        amountMinor: 800000,
        retainedMinor: 0,
        rule: "host_cancelled",
      }),
    );
    expect(c.ledger.rows).toHaveLength(0);
    expect(c.UserModel.updateOne).toHaveBeenCalledTimes(1);
    expect(c.UserModel.updates[0]).toEqual([
      { _id: c.host._id },
      { $inc: { hostCancellationCount: 1 } },
    ]);
    consistent(c);
  });

  test("a reason is required (and a blank one does not count)", async () => {
    const c = setup();
    const b = c.add();
    for (const reason of [undefined, "", "   "]) {
      await expect(c.cancel(b._id, c.host, reason)).rejects.toThrow(
        /tell the guest why/,
      );
    }
    expect(c.doc(b).status).toBe("confirmed");
    expect(c.UserModel.updateOne).not.toHaveBeenCalled();
  });

  test("a pending request is declined, not cancelled", async () => {
    const c = setup();
    const b = c.add({ status: "pending" });
    await expect(c.cancel(b._id, c.host, "No")).rejects.toMatchObject({
      statusCode: 409,
      code: "use_decline",
    });
    expect(c.doc(b).status).toBe("pending");
  });

  test("a failing counter never undoes or fails the cancellation; it is logged", async () => {
    const c = setup({ counterFails: true });
    const b = c.add();
    await expect(c.cancel(b._id, c.host, "Sorry")).resolves.toEqual(
      expect.objectContaining({ actor: "host" }),
    );
    expect(c.doc(b).status).toBe("cancelled_by_host");
    expect(c.logger.error).toHaveBeenCalledTimes(1);
  });

  test("two attempts at once: one cancels and is counted once, the other is told it changed", async () => {
    const c = setup();
    const b = c.add();
    const results = await Promise.allSettled([
      c.cancel(b._id, c.host, "A"),
      c.cancel(b._id, c.host, "B"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost.reason).toBeInstanceOf(ConflictError);
    expect(c.UserModel.updateOne).toHaveBeenCalledTimes(1);
    expect(
      c.doc(b).statusHistory.filter((h) => h.to === "cancelled_by_host"),
    ).toHaveLength(1);
    consistent(c);
  });
});

describe("who may cancel, and races", () => {
  test("a stranger, an admin and a signed-out visitor get the same 404 as for a missing booking", async () => {
    const c = setup();
    const b = c.add();
    for (const who of [
      c.stranger,
      c.admin,
      undefined,
      { ...c.guest, status: "suspended" },
    ]) {
      await expect(c.cancel(b._id, who, "x")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    await expect(c.cancel(fakeId(), c.guest)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    for (const id of [
      "not-an-id",
      "",
      undefined,
      "a".repeat(23),
      { $gt: "" },
    ]) {
      await expect(c.cancel(id, c.guest)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(c.doc(b).status).toBe("confirmed");
  });

  test("the reason must be text of at most 500 characters (too long is refused, never cut)", async () => {
    const c = setup();
    const b = c.add();
    await expect(
      c.cancel(b._id, c.guest, "x".repeat(501)),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(c.cancel(b._id, c.guest, ["a"])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await c.cancel(b._id, c.guest, "x".repeat(500));
    expect(c.doc(b).cancelReason).toHaveLength(500);
  });

  test("the guest cancels while the host cancels: exactly one wins, the guest's refund never replaces the host's", async () => {
    const c = setup();
    const b = c.add({ policy: "strict" });
    const nearly = new Date(day(CHECK_IN).getTime() - 3600000);
    const results = await Promise.allSettled([
      c.cancel(b._id, c.guest, "g", nearly),
      c.cancel(b._id, c.host, "h", nearly),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stored = c.doc(b);
    expect(["cancelled_by_guest", "cancelled_by_host"]).toContain(
      stored.status,
    );
    if (stored.status === "cancelled_by_host")
      expect(stored.refund.amountMinor).toBe(800000);
    else expect(stored.refund.amountMinor).toBe(0); // strict, an hour before check-in
    expect(c.UserModel.updateOne).toHaveBeenCalledTimes(
      stored.status === "cancelled_by_host" ? 1 : 0,
    );
    consistent(c);
  });

  test("a guest cancelling a request the host accepted in the meantime is told it changed, not given the request refund", async () => {
    const c = setup();
    const b = c.add({ status: "pending", policy: "strict" });
    const real = c.Reservation.findById.bind(c.Reservation);
    let first = true;
    c.Reservation.findById = async (id) => {
      const found = await real(id);
      if (first) {
        first = false;
        return {
          ...found,
          status: "pending",
          checkIn: found.checkIn,
          checkOut: found.checkOut,
        };
      }
      return real(id);
    };
    // the host accepts after the service read "pending" and before it moves the booking
    const originalTransition = c.Reservation.findOneAndUpdate.bind(
      c.Reservation,
    );
    c.Reservation.findOneAndUpdate = async (filter, update) => {
      Object.assign(c.doc(b), { status: "confirmed" });
      delete c.doc(b).holdExpiresAt;
      return originalTransition(filter, update);
    };
    await expect(c.cancel(b._id, c.guest)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(c.doc(b).status).toBe("confirmed");
    expect(c.doc(b).refund).toBeUndefined();
  });
});

describe("mayCancel and cancelOffer (what the booking page shows)", () => {
  const info = {
    formatMoney,
    formatInstant: (d, tz) => `${d.toISOString()} ${tz}`,
  };
  const res = (extra = {}) => ({
    status: "confirmed",
    checkIn: day(CHECK_IN),
    checkOut: day("2026-12-13"),
    nights: 3,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    listingSnapshot: {
      timezone: "Asia/Kolkata",
      checkInTime: "14:00",
      cancellationPolicy: "flexible",
    },
    pricingSnapshot: {
      totalMinor: 800000,
      subtotalMinor: 750000,
      avgPerNightMinor: 250000,
      currency: "INR",
    },
    ...extra,
  });

  test("the guest may cancel pending and confirmed; the host only confirmed; nobody once the stay is over", () => {
    expect(mayCancel(res({ status: "pending" }), "guest", T0)).toBe(true);
    expect(mayCancel(res({ status: "confirmed" }), "guest", T0)).toBe(true);
    expect(mayCancel(res({ status: "pending" }), "host", T0)).toBe(false);
    expect(mayCancel(res({ status: "confirmed" }), "host", T0)).toBe(true);
    for (const status of [
      "declined",
      "expired",
      "cancelled_by_guest",
      "cancelled_by_host",
      "completed",
    ]) {
      expect(mayCancel(res({ status }), "guest", T0)).toBe(false);
    }
  });

  test("the day after check-out in the listing's zone ends it, not the server's day", () => {
    // 2026-12-12T18:29Z is still 12 Dec 23:59 in Kolkata; 18:30Z is 13 Dec 00:00
    expect(mayCancel(res(), "guest", new Date("2026-12-12T18:29:00Z"))).toBe(
      true,
    );
    expect(mayCancel(res(), "guest", new Date("2026-12-12T18:30:00Z"))).toBe(
      false,
    );
  });

  test("the offer says what would come back, until when it is free and why", () => {
    const early = cancelOffer(res(), { actor: "guest", now: T0, ...info });
    expect(early).toEqual(
      expect.objectContaining({
        full: true,
        refundText: "₹8,000",
        reasonRequired: false,
        ruleText: expect.stringMatching(/full refund/),
      }),
    );
    expect(early.freeUntilText).toContain(
      "2026-12-09T08:30:00.000Z Asia/Kolkata",
    );
    const late = cancelOffer(res(), {
      actor: "guest",
      now: new Date("2026-12-10T05:00:00Z"),
      ...info,
    });
    expect(late).toEqual(
      expect.objectContaining({
        full: false,
        refundText: "₹5,500",
        keptText: "₹2,500",
        totalText: "₹8,000",
        freeUntilText: null,
      }),
    );
    const none = cancelOffer(res(), {
      actor: "guest",
      now: new Date("2026-12-11T00:00:00Z"),
      ...info,
    });
    expect(none.refundMinor).toBe(0);
  });

  test("the host's offer is a full refund and needs a reason; nothing is offered when it cannot be done", () => {
    expect(cancelOffer(res(), { actor: "host", now: T0, ...info })).toEqual(
      expect.objectContaining({ full: true, reasonRequired: true }),
    );
    expect(
      cancelOffer(res({ status: "completed" }), {
        actor: "guest",
        now: T0,
        ...info,
      }),
    ).toBeNull();
    expect(
      cancelOffer(res({ status: "pending" }), {
        actor: "host",
        now: T0,
        ...info,
      }),
    ).toBeNull();
  });
});
