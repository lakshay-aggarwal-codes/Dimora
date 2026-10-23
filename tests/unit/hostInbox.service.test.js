// P09-T02: accepting and declining requests, and the inbox data, against
// in-memory fakes (no database). Every answer ends with the ledger/reservation
// invariant check. The routes and views are in tests/integration/hostInbox.routes.test.js.
const { ObjectId } = require("mongoose").Types;
const { createReservationService } = require("../../src/services/reservations");
const inbox = require("../../src/services/hostInbox");
const pricing = require("../../src/services/pricing");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require("../../src/utils/errors");
const {
  FakeReservationModel,
  FakeListingModel,
  FakeLedger,
  fakeId,
} = require("../helpers/fakeReservationDeps");
const { findViolations } = require("../helpers/invariants");

const NOW = new Date();
const TODAY = todayIn("Asia/Kolkata", NOW);
const D = (n) => formatDateOnly(addDays(TODAY, n));
const HOUR = 3600000;
const HOST = { _id: fakeId(), status: "active" };
const OTHER_HOST = { _id: fakeId(), status: "active" };
const GUEST = { _id: fakeId(), status: "active" };
const ADMIN = { _id: fakeId(), status: "active", role: "admin" };
let keyN = 0;
const key = () => `inbox-key-${(keyN += 1)}-abcdefgh`;

function setup(listingExtra = {}) {
  const Reservation = new FakeReservationModel();
  const listing = {
    _id: fakeId(),
    owner: HOST._id,
    status: "published",
    deletedAt: null,
    title: "Sea house",
    address: { city: "Goa" },
    pricing: { nightlyMinor: 250000, cleaningFeeMinor: 50000, currency: "INR" },
    capacity: { guests: 4 },
    minNights: 1,
    maxNights: 14,
    instantBook: false,
    cancellationPolicy: "moderate",
    checkInTime: "14:00",
    checkOutTime: "11:00",
    timezone: "Asia/Kolkata",
    houseRules: "No parties",
    images: [{ url: "https://img/x.jpg" }],
    ...listingExtra,
  };
  const Listing = new FakeListingModel([listing]);
  const ledger = new FakeLedger();
  const service = createReservationService({
    ReservationModel: Reservation,
    ListingModel: Listing,
    ledgerService: ledger,
    pricing,
    newId: fakeId,
    replayRetries: 20,
    replayDelayMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const request = async (over = {}) =>
    (
      await service.create(
        {
          guest: GUEST,
          listing: listing._id,
          in: D(10),
          out: D(13),
          guests: 2,
          idempotencyKey: key(),
          ...over,
        },
        { now: NOW },
      )
    ).reservation;
  const run = (over) =>
    inbox.respond(
      {
        ReservationModel: Reservation,
        ListingModel: Listing,
        reservationService: service,
      },
      { user: HOST, now: NOW, ...over },
    );
  const consistent = () =>
    expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
  return {
    Reservation,
    Listing,
    listing,
    ledger,
    service,
    request,
    run,
    consistent,
  };
}

describe("parseReason", () => {
  test("optional text, trimmed", () => {
    expect(inbox.parseReason(undefined)).toBe("");
    expect(inbox.parseReason(null)).toBe("");
    expect(inbox.parseReason("   ")).toBe("");
    expect(inbox.parseReason("  Dates clash with repairs ")).toBe(
      "Dates clash with repairs",
    );
  });
  test("exactly 500 is fine, 501 is refused (never silently cut)", () => {
    expect(inbox.parseReason("x".repeat(500))).toHaveLength(500);
    expect(() => inbox.parseReason("x".repeat(501))).toThrow(ValidationError);
  });
  test.each([[5], [{ a: 1 }], [["a"]], [true]])("not text: %j", (bad) => {
    expect(() => inbox.parseReason(bad)).toThrow(ValidationError);
  });
});

describe("countdownText", () => {
  const at = (ms) => new Date(NOW.getTime() + ms);
  test.each([
    [-1000, ""],
    [0, ""],
    [30 * 1000, "less than a minute"],
    [42 * 60000, "42 min"],
    [5 * HOUR + 12 * 60000, "5 h 12 min"],
    [HOUR, "1 h 0 min"],
    [26 * HOUR, "1 day 2 h"],
    [49 * HOUR, "2 days 1 h"],
  ])("%i ms left -> %j", (ms, text) =>
    expect(inbox.countdownText(at(ms), NOW)).toBe(text),
  );
});

describe("respond: accept", () => {
  test("the host accepts a live request: confirmed, hold gone, nights kept, history says host", async () => {
    const { Reservation, ledger, request, run, consistent } = setup();
    const reservation = await request();
    expect(ledger.rows.every((r) => r.holdExpiresAt)).toBe(true);
    const updated = await run({ id: reservation._id, decision: "accept" });
    expect(updated.status).toBe("confirmed");
    expect(updated.holdExpiresAt).toBeUndefined();
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows.some((r) => r.holdExpiresAt)).toBe(false);
    const last = Reservation.docs[0].statusHistory.at(-1);
    expect(last).toMatchObject({
      from: "pending",
      to: "confirmed",
      actor: "host",
    });
    expect(String(last.by)).toBe(String(HOST._id));
    consistent();
  });

  test("an expired request: 409 hold_expired, nothing changes", async () => {
    const { Reservation, ledger, request, run, consistent } = setup();
    const reservation = await request();
    const late = new Date(NOW.getTime() + 25 * HOUR);
    await expect(
      run({ id: reservation._id, decision: "accept", now: late }),
    ).rejects.toMatchObject({ statusCode: 409, code: "hold_expired" });
    expect(Reservation.docs[0].status).toBe("pending");
    expect(ledger.rows).toHaveLength(3);
    consistent();
  });

  test("after the listing was suspended: 409 listing_suspended, still pending, but declining works", async () => {
    const { Reservation, listing, request, run, ledger, consistent } = setup();
    const reservation = await request();
    listing.status = "suspended";
    await expect(
      run({ id: reservation._id, decision: "accept" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "listing_suspended" });
    expect(Reservation.docs[0].status).toBe("pending");
    await run({
      id: reservation._id,
      decision: "decline",
      reason: "Listing taken down",
    });
    expect(Reservation.docs[0].status).toBe("declined");
    expect(ledger.rows).toHaveLength(0);
    consistent();
  });

  test.each([
    ["deleted", { deletedAt: new Date() }],
    ["gone", null],
  ])("a %s listing cannot accept", async (_n, change) => {
    const { Reservation, Listing, listing, request, run } = setup();
    const reservation = await request();
    if (change) Object.assign(listing, change);
    else Listing.listings.length = 0;
    await expect(
      run({ id: reservation._id, decision: "accept" }),
    ).rejects.toMatchObject({ code: "listing_suspended" });
    expect(Reservation.docs[0].status).toBe("pending");
  });

  test("an unpublished (by the host) listing still honours a request", async () => {
    const { listing, request, run } = setup();
    const reservation = await request();
    listing.status = "unpublished";
    expect(
      (await run({ id: reservation._id, decision: "accept" })).status,
    ).toBe("confirmed");
  });

  test("accepting twice: the second is a 409 and nothing changes again", async () => {
    const { Reservation, request, run, consistent } = setup();
    const reservation = await request();
    await run({ id: reservation._id, decision: "accept" });
    const history = Reservation.docs[0].statusHistory.length;
    await expect(
      run({ id: reservation._id, decision: "accept" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(Reservation.docs[0].statusHistory).toHaveLength(history);
    consistent();
  });
});

describe("respond: decline", () => {
  test("declined with a reason: nights released, reason in the history", async () => {
    const { Reservation, ledger, request, run, consistent } = setup();
    const reservation = await request();
    const updated = await run({
      id: reservation._id,
      decision: "decline",
      reason: "  Dates clash with repairs ",
    });
    expect(updated.status).toBe("declined");
    expect(ledger.rows).toHaveLength(0);
    expect(Reservation.docs[0].statusHistory.at(-1)).toMatchObject({
      from: "pending",
      to: "declined",
      actor: "host",
      note: "Dates clash with repairs",
    });
    consistent();
  });

  test("the reason is optional", async () => {
    const { Reservation, request, run } = setup();
    const reservation = await request();
    await run({ id: reservation._id, decision: "decline" });
    expect(Reservation.docs[0].statusHistory.at(-1).note).toBeUndefined();
  });

  test("a reason that is too long is a 400 and the request stays pending", async () => {
    const { Reservation, request, run } = setup();
    const reservation = await request();
    await expect(
      run({
        id: reservation._id,
        decision: "decline",
        reason: "x".repeat(501),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(Reservation.docs[0].status).toBe("pending");
  });

  test("an accept ignores any reason sent along", async () => {
    const { Reservation, request, run } = setup();
    const reservation = await request();
    await run({
      id: reservation._id,
      decision: "accept",
      reason: "x".repeat(900),
    });
    expect(Reservation.docs[0].status).toBe("confirmed");
    expect(Reservation.docs[0].statusHistory.at(-1).note).toBeUndefined();
  });

  test("declining something already confirmed is refused (use cancellation)", async () => {
    const { request, run } = setup();
    const reservation = await request();
    await run({ id: reservation._id, decision: "accept" });
    await expect(
      run({ id: reservation._id, decision: "decline" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("respond: who may", () => {
  test.each([
    ["the guest", GUEST],
    ["another host", OTHER_HOST],
    ["an admin", ADMIN],
    ["a signed-out visitor", undefined],
    ["a suspended host", { ...HOST, status: "suspended" }],
  ])(
    "%s gets the 404 for a booking that does not exist, and nothing changes",
    async (_n, user) => {
      const { Reservation, request, run, ledger } = setup();
      const reservation = await request();
      for (const decision of ["accept", "decline"]) {
        await expect(
          run({ id: reservation._id, decision, user }),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(Reservation.docs[0].status).toBe("pending");
      expect(ledger.rows).toHaveLength(3);
    },
  );

  test.each([
    "nope",
    "123",
    String(new ObjectId()).slice(1),
    "",
    undefined,
    null,
  ])("a missing or malformed id %j is a 404", async (id) => {
    const { run } = setup();
    await expect(run({ id, decision: "accept" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("the decision must be accept or decline", async () => {
    const { request, run } = setup();
    const reservation = await request();
    await expect(
      run({ id: reservation._id, decision: "confirmed" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("respond: a race", () => {
  test("accept, decline and the guest's cancel at once: exactly one wins and the data is consistent", async () => {
    const { Reservation, ledger, request, run, service, consistent } = setup();
    const reservation = await request();
    const settled = await Promise.allSettled([
      run({ id: reservation._id, decision: "accept" }),
      run({ id: reservation._id, decision: "decline" }),
      service.transition(reservation._id, "cancelled_by_guest", {
        actor: "guest",
        now: NOW,
      }),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === "rejected"))
      expect(s.reason.statusCode).toBe(409);
    expect(ledger.rows).toHaveLength(
      Reservation.docs[0].status === "confirmed" ? 3 : 0,
    );
    consistent();
  });
});

describe("describeInboxRow / listInbox", () => {
  const guestDoc = {
    _id: new ObjectId(),
    displayName: "Ravi",
    username: "ravi",
    createdAt: new Date("2025-03-10T00:00:00Z"),
  };
  const row = (extra = {}) => ({
    _id: new ObjectId(),
    guest: guestDoc,
    host: new ObjectId(),
    status: "pending",
    holdExpiresAt: new Date(NOW.getTime() + 5 * HOUR + 12 * 60000),
    checkIn: new Date("2026-12-01T00:00:00Z"),
    checkOut: new Date("2026-12-04T00:00:00Z"),
    nights: 3,
    guests: 2,
    pricingSnapshot: { totalMinor: 800000, currency: "INR" },
    listingSnapshot: { title: "Sea house", timezone: "Asia/Kolkata" },
    ...extra,
  });

  test("a live request: countdown, deadline, can be answered, guest summary", () => {
    const doc = row();
    const view = inbox.describeInboxRow(doc, {
      previousStays: new Map([[String(guestDoc._id), 2]]),
      now: NOW,
    });
    expect(view).toMatchObject({
      canAnswer: true,
      expiresText: "5 h 12 min",
      listingTitle: "Sea house",
      checkIn: "1 Dec 2026",
      checkOut: "4 Dec 2026",
      nights: 3,
      guest: {
        name: "Ravi",
        memberSince: "Mar 2025",
        previousStays: 2,
        profileUrl: `/users/${guestDoc._id}`,
      },
    });
    expect(view.expiresAtIso).toBe(doc.holdExpiresAt.toISOString());
    expect(view.guestTotal.replace(/\u00a0/g, " ")).toBe("₹8,000");
  });

  test("a lapsed request cannot be answered and has no countdown", () => {
    const view = inbox.describeInboxRow(
      row({ holdExpiresAt: new Date(NOW.getTime() - HOUR) }),
      { previousStays: new Map(), now: NOW },
    );
    expect(view).toMatchObject({
      canAnswer: false,
      expiresText: null,
      expiresAtIso: null,
    });
    expect(view.guest.previousStays).toBe(0);
  });

  test("a guest account that is gone is shown as a plain 'A guest'", () => {
    const view = inbox.describeInboxRow(row({ guest: new ObjectId() }), {
      previousStays: new Map(),
      now: NOW,
    });
    expect(view.guest).toEqual({
      name: "A guest",
      profileUrl: null,
      memberSince: null,
      previousStays: 0,
    });
  });

  function fakeModel({ pending = [], confirmed = [], completed = [] } = {}) {
    const calls = [];
    return {
      calls,
      find: jest.fn((filter) => {
        const entry = { filter };
        calls.push(entry);
        const rows = filter.status === "pending" ? pending : confirmed;
        const q = {
          sort: (s) => ((entry.sort = s), q),
          limit: (n) => ((entry.limit = n), q),
          populate: () => q,
          lean: async () => rows,
        };
        return q;
      }),
      aggregate: jest.fn(async (pipeline) => {
        calls.push({ pipeline });
        return completed;
      }),
    };
  }

  test("both lists are this host's; pending by soonest deadline, confirmed by soonest check-in", async () => {
    const hostId = new ObjectId();
    const model = fakeModel({
      pending: [row()],
      confirmed: [row({ status: "confirmed", holdExpiresAt: undefined })],
      completed: [{ _id: guestDoc._id, count: 3 }],
    });
    const result = await inbox.listInbox({ ReservationModel: model }, hostId, {
      now: NOW,
    });
    const [pendingCall, confirmedCall, aggregate] = model.calls;
    expect(pendingCall.filter).toEqual({ host: hostId, status: "pending" });
    expect(pendingCall.sort).toEqual({ holdExpiresAt: 1, _id: 1 });
    expect(confirmedCall.filter).toMatchObject({
      host: hostId,
      status: "confirmed",
      checkOut: { $gt: TODAY },
    });
    expect(confirmedCall.sort).toEqual({ checkIn: 1, _id: 1 });
    expect(aggregate.pipeline[0].$match).toMatchObject({
      host: hostId,
      status: "completed",
    });
    expect(result.pending).toHaveLength(1);
    expect(result.confirmed).toHaveLength(1);
    expect(result.pending[0].guest.previousStays).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("an empty inbox asks nothing about earlier stays", async () => {
    const model = fakeModel();
    const result = await inbox.listInbox(
      { ReservationModel: model },
      new ObjectId(),
      { now: NOW },
    );
    expect(model.aggregate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pending: [],
      confirmed: [],
      truncated: false,
    });
  });

  test("more than 50 in a list: the first 50 are shown and the page says so", async () => {
    const many = Array.from({ length: 51 }, () => row());
    const result = await inbox.listInbox(
      { ReservationModel: fakeModel({ pending: many }) },
      new ObjectId(),
      { now: NOW },
    );
    expect(result.pending).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});
