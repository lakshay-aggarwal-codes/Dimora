// P09-T01: the trips service (tabs, rows, the confirmation page's data) with
// plain objects and a fake model. The routes and views are in
// tests/integration/trips.routes.test.js.
const { ObjectId } = require("mongoose").Types;
const trips = require("../../src/services/trips");
const { formatMoney } = require("../../src/utils/money");
const { parseDateOnly } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
// 20 Oct 2026, 11:30 in Kolkata. "Today" there is 2026-10-20.
const NOW = new Date("2026-10-20T06:00:00Z");
const TODAY = d("2026-10-20");
const HOUR = 3600000;

const guestId = new ObjectId();
const hostId = new ObjectId();

function reservation(extra = {}) {
  return {
    _id: new ObjectId("64b0f0f0f0f0f0f0f0f0abcd"),
    guest: guestId,
    host: hostId,
    listing: {
      _id: new ObjectId(),
      title: "Live title",
      address: {
        line1: "12 Beach Road",
        city: "Goa",
        state: "Goa",
        postalCode: "403001",
        country: "India",
      },
      geometry: { type: "Point", coordinates: [73.8, 15.5] },
    },
    checkIn: d("2026-11-02"),
    checkOut: d("2026-11-05"),
    nights: 3,
    guests: 2,
    status: "confirmed",
    holdExpiresAt: undefined,
    pricingSnapshot: {
      lines: [
        { code: "nights", unitMinor: 250000, quantity: 3, amountMinor: 750000 },
        { code: "cleaning", amountMinor: 50000 },
        { code: "service_fee", amountMinor: 80000 },
        { code: "tax", amountMinor: 105600, included: false },
      ],
      totalMinor: 985600,
      avgPerNightMinor: 328533,
      currency: "INR",
      taxIncluded: false,
    },
    listingSnapshot: {
      title: "Sea house",
      city: "Goa",
      coverUrl: "https://img/x.jpg",
      houseRules: "No parties",
      noSpecialRules: false,
      cancellationPolicy: "moderate",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      timezone: "Asia/Kolkata",
      instantBook: false,
    },
    ...extra,
  };
}

describe("parseTab / parsePage", () => {
  test("only the four tabs are accepted, upcoming by default", () => {
    for (const key of ["upcoming", "pending", "past", "cancelled"])
      expect(trips.parseTab(key)).toBe(key);
    for (const bad of [
      undefined,
      "",
      "all",
      "UPCOMING",
      ["past"],
      { x: 1 },
      "past; drop",
    ])
      expect(trips.parseTab(bad)).toBe("upcoming");
  });
  test("pages are whole numbers of 1 or more", () => {
    expect(trips.parsePage("3")).toBe(3);
    for (const bad of [undefined, "0", "-1", "1.5", "x", "", ["2"], "9999999"])
      expect(trips.parsePage(bad)).toBe(1);
  });
});

describe("tabOf: every booking is in exactly one tab", () => {
  const tab = (extra) => trips.tabOf(reservation(extra), { now: NOW });
  const hold = (ms) => new Date(NOW.getTime() + ms);
  test.each([
    [
      "confirmed, check-out ahead",
      { status: "confirmed", checkOut: d("2026-10-21") },
      "upcoming",
    ],
    [
      "confirmed, check-out today (the stay has ended)",
      { status: "confirmed", checkOut: d("2026-10-20") },
      "past",
    ],
    [
      "confirmed, check-out passed (sweeper has not run)",
      { status: "confirmed", checkOut: d("2026-10-10") },
      "past",
    ],
    ["completed", { status: "completed" }, "past"],
    [
      "pending with a running hold",
      { status: "pending", holdExpiresAt: hold(HOUR) },
      "pending",
    ],
    [
      "pending with the hold ended",
      { status: "pending", holdExpiresAt: hold(-HOUR) },
      "cancelled",
    ],
    [
      "pending with no hold at all",
      { status: "pending", holdExpiresAt: undefined },
      "cancelled",
    ],
    ["declined", { status: "declined" }, "cancelled"],
    ["expired", { status: "expired" }, "cancelled"],
    ["cancelled by guest", { status: "cancelled_by_guest" }, "cancelled"],
    ["cancelled by host", { status: "cancelled_by_host" }, "cancelled"],
  ])("%s", (_n, extra, expected) => expect(tab(extra)).toBe(expected));
});

describe("tabQuery", () => {
  const ctx = { now: NOW, today: TODAY };
  test("every query is limited to the guest", () => {
    for (const key of ["upcoming", "pending", "past", "cancelled"]) {
      expect(trips.tabQuery(key, guestId, ctx).filter.guest).toBe(guestId);
    }
  });
  test("shapes", () => {
    expect(trips.tabQuery("upcoming", guestId, ctx).filter).toEqual({
      guest: guestId,
      status: "confirmed",
      checkOut: { $gt: TODAY },
    });
    expect(trips.tabQuery("pending", guestId, ctx).filter).toEqual({
      guest: guestId,
      status: "pending",
      holdExpiresAt: { $gt: NOW },
    });
    expect(trips.tabQuery("past", guestId, ctx).filter.$or).toEqual([
      { status: "completed" },
      { status: "confirmed", checkOut: { $lte: TODAY } },
    ]);
    const cancelled = trips.tabQuery("cancelled", guestId, ctx).filter.$or;
    expect(cancelled[0].status.$in.sort()).toEqual([
      "cancelled_by_guest",
      "cancelled_by_host",
      "declined",
      "expired",
    ]);
    expect(cancelled[1]).toEqual({
      status: "pending",
      holdExpiresAt: { $lte: NOW },
    });
  });
  test("an unknown tab is a bug, not a silent default", () => {
    expect(() => trips.tabQuery("everything", guestId, ctx)).toThrow(TypeError);
  });
  test("sorting: soonest stay first, newest past first, soonest deadline first", () => {
    expect(trips.tabQuery("upcoming", guestId, ctx).sort).toEqual({
      checkIn: 1,
      _id: 1,
    });
    expect(trips.tabQuery("past", guestId, ctx).sort).toEqual({
      checkOut: -1,
      _id: -1,
    });
    expect(trips.tabQuery("pending", guestId, ctx).sort).toEqual({
      holdExpiresAt: 1,
      _id: 1,
    });
  });
});

describe("statusInfo", () => {
  test("wording depends on who is looking", () => {
    expect(
      trips.statusInfo(reservation({ status: "cancelled_by_guest" }), {
        viewerIsGuest: true,
      }).label,
    ).toBe("Cancelled by you");
    expect(
      trips.statusInfo(reservation({ status: "cancelled_by_guest" }), {
        viewerIsGuest: false,
      }).label,
    ).toBe("Cancelled by the guest");
    expect(
      trips.statusInfo(reservation({ status: "cancelled_by_host" })).label,
    ).toBe("Cancelled by the host");
  });
  test("a request whose hold ended reads as expired before the sweeper has run", () => {
    expect(
      trips.statusInfo(
        reservation({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() - HOUR),
        }),
        { now: NOW },
      ).label,
    ).toBe("Request expired");
    expect(
      trips.statusInfo(
        reservation({
          status: "pending",
          holdExpiresAt: new Date(NOW.getTime() + HOUR),
        }),
        { now: NOW },
      ).label,
    ).toBe("Waiting for the host");
  });
});

describe("formatting", () => {
  test("stay dates are date-only in UTC, so no zone moves them", () => {
    expect(trips.formatStayDate(d("2026-11-02"))).toBe("2 Nov 2026");
    expect(trips.formatStayDate(d("2027-01-01"))).toBe("1 Jan 2027");
  });
  test("breakdown lines read like the quote panel", () => {
    const plain = (t) => t.replace(/\u00a0/g, " ");
    expect(
      plain(
        trips.lineLabel(
          { code: "nights", unitMinor: 250000, quantity: 3 },
          formatMoney,
          "INR",
        ),
      ),
    ).toBe("₹2,500 × 3 nights");
    expect(
      plain(
        trips.lineLabel(
          { code: "weekend_nights", unitMinor: 300000, quantity: 1 },
          formatMoney,
          "INR",
        ),
      ),
    ).toBe("₹3,000 × 1 weekend night");
    expect(
      trips.lineLabel({ code: "tax", included: true }, formatMoney, "INR"),
    ).toBe("Taxes (included in the price)");
    expect(trips.lineLabel({ code: "mystery" }, formatMoney, "INR")).toBe(
      "Other charges",
    );
  });
  test("the reference is the last 8 characters of the id", () => {
    expect(trips.referenceOf(reservation())).toBe("DIM-F0F0ABCD");
  });
});

describe("describeRow", () => {
  test("reads the snapshots, not the live listing", () => {
    const row = trips.describeRow(reservation(), { now: NOW });
    expect(row).toMatchObject({
      listingTitle: "Sea house",
      city: "Goa",
      coverUrl: "https://img/x.jpg",
      checkIn: "2 Nov 2026",
      checkOut: "5 Nov 2026",
      nights: 3,
      guests: 2,
      statusLabel: "Confirmed",
      totalMinor: 985600,
      currency: "INR",
      holdsUntil: null,
    });
    expect(row.id).toBe("64b0f0f0f0f0f0f0f0f0abcd");
  });
  test("a pending request shows when the host's time runs out", () => {
    const row = trips.describeRow(
      reservation({
        status: "pending",
        holdExpiresAt: new Date("2026-10-21T06:00:00Z"),
      }),
      { now: NOW },
    );
    expect(row.holdsUntil).toBe("21 Oct, 11:30 am");
  });
  test("a booking with an incomplete snapshot still renders", () => {
    const row = trips.describeRow(
      {
        _id: new ObjectId(),
        checkIn: d("2026-11-02"),
        checkOut: d("2026-11-03"),
        nights: 1,
        guests: 1,
        status: "declined",
      },
      { now: NOW },
    );
    expect(row.listingTitle).toBe("A place on Dimora");
    expect(row.totalMinor).toBeNull();
  });
});

describe("describeTrip", () => {
  const host = {
    _id: hostId,
    displayName: "Asha",
    username: "asha",
    email: "asha@example.com",
  };
  const guest = { _id: guestId, displayName: "Ravi", username: "ravi" };
  const trip = (extra, role = "guest") =>
    trips.describeTrip(reservation({ host, guest, ...extra }), {
      viewerRole: role,
      formatMoney,
      now: NOW,
    });

  test("the price is the stored snapshot, line for line, in integer paise", () => {
    const t = trip({});
    expect(t.lines.map((l) => l.amount.replace(/\u00a0/g, " "))).toEqual([
      "₹7,500",
      "₹500",
      "₹800",
      "₹1,056",
    ]);
    expect(t.totalMinor).toBe(985600);
    expect(t.totalText.replace(/\u00a0/g, " ")).toBe("₹9,856");
    expect(t.lines[0].label.replace(/\u00a0/g, " ")).toBe("₹2,500 × 3 nights");
  });

  test("title, rules and policy come from the snapshot even if the listing has changed", () => {
    const t = trip({});
    expect(t.listing.title).toBe("Sea house");
    expect(t.houseRules).toBe("No parties");
    expect(t.cancellation.label).toBe("Moderate");
    expect(t.cancellation.terms).toMatch(/5 days before check-in/);
    expect(t.checkInTime).toBe("14:00");
  });

  test.each(["confirmed", "completed"])(
    "%s: the host's contact and the exact address are shown to the guest",
    (status) => {
      const t = trip({ status });
      expect(t.revealed).toBe(true);
      expect(t.hostContact).toEqual({
        name: "Asha",
        email: "asha@example.com",
        profileUrl: `/users/${hostId}`,
      });
      expect(t.address).toEqual([
        "12 Beach Road",
        "Goa",
        "Goa 403001",
        "India",
      ]);
      expect(t.mapUrl).toBe(
        "https://www.openstreetmap.org/?mlat=15.5&mlon=73.8#map=17/15.5/73.8",
      );
    },
  );

  test.each([
    "pending",
    "declined",
    "expired",
    "cancelled_by_guest",
    "cancelled_by_host",
  ])("%s: no contact, no address, no map", (status) => {
    const t = trip({
      status,
      holdExpiresAt:
        status === "pending" ? new Date(NOW.getTime() + HOUR) : undefined,
    });
    expect(t.revealed).toBe(false);
    expect(t.hostContact).toBeNull();
    expect(t.address).toBeNull();
    expect(t.mapUrl).toBeNull();
    expect(JSON.stringify(t)).not.toMatch(/asha@example|Beach Road|15\.5/);
  });

  test("the host looking at the booking sees the guest's name, never a 'host contact'", () => {
    const t = trip({}, "host");
    expect(t.guestName).toBe("Ravi");
    expect(t.hostContact).toBeNull();
    expect(JSON.stringify(t)).not.toMatch(/asha@example/);
  });

  test("the guest never receives the guest's own contact block or anyone's email but the host's", () => {
    const t = trip({});
    expect(t.guestName).toBeNull();
    expect(JSON.stringify(t)).not.toMatch(/ravi@/);
  });

  test("a pending request shows the deadline and the instant-book flag is carried", () => {
    const t = trip({
      status: "pending",
      holdExpiresAt: new Date("2026-10-21T06:00:00Z"),
    });
    expect(t.holdsUntil).toBe("21 Oct, 11:30 am");
    expect(t.instantBook).toBe(false);
    expect(
      trip({
        listingSnapshot: {
          ...reservation().listingSnapshot,
          instantBook: true,
        },
      }).instantBook,
    ).toBe(true);
  });

  test("a deleted listing or host does not break the page", () => {
    const t = trips.describeTrip(
      reservation({ listing: null, host: hostId, guest: guestId }),
      { viewerRole: "guest", formatMoney, now: NOW },
    );
    expect(t.listing.url).toBeNull();
    expect(t.address).toBeNull();
    expect(t.hostContact).toBeNull();
    expect(t.listing.title).toBe("Sea house");
  });

  test("a soft-deleted listing has no link", () => {
    expect(
      trip({ listing: { _id: new ObjectId(), deletedAt: new Date() } }).listing
        .url,
    ).toBeNull();
  });

  test("no special rules", () => {
    const t = trip({
      listingSnapshot: {
        ...reservation().listingSnapshot,
        noSpecialRules: true,
        houseRules: "",
      },
    });
    expect(t.noSpecialRules).toBe(true);
    expect(t.houseRules).toBe("");
  });

  test("an address of the old free-text kind is used when there is no structured one", () => {
    const t = trip({
      listing: {
        _id: new ObjectId(),
        address: {},
        location: "Candolim",
        country: "India",
      },
    });
    expect(t.address).toEqual(["Candolim", "India"]);
  });

  test("an unknown policy shows no terms rather than invented ones", () => {
    expect(
      trip({
        listingSnapshot: {
          ...reservation().listingSnapshot,
          cancellationPolicy: "whatever",
        },
      }).cancellation,
    ).toBeNull();
  });

  test("a declined request carries the host's reason from the status history", () => {
    const history = [
      { from: null, to: "pending", actor: "guest", at: NOW },
      { from: "pending", to: "declined", actor: "host", at: NOW, note: "Repairs that week" },
    ];
    expect(trip({ status: "declined", statusHistory: history }).declineReason).toBe("Repairs that week");
    expect(trip({ status: "declined", statusHistory: history.slice(0, 1) }).declineReason).toBe("");
    expect(trip({ status: "declined" }).declineReason).toBe("");
    // a reason is never shown for any other status
    expect(trip({ status: "confirmed", statusHistory: history }).declineReason).toBe("");
  });

  test("payment is stated as simulated", () => {
    expect(trip({}).paymentSimulated).toBe(true);
  });
});

describe("listTrips", () => {
  function fakeModel(rowsByCall) {
    const calls = { counts: [], finds: [] };
    return {
      calls,
      countDocuments: jest.fn(async (filter) => {
        calls.counts.push(filter);
        return rowsByCall.counts[calls.counts.length - 1];
      }),
      find: jest.fn((filter) => {
        const query = { filter, sort: null, skip: null, limit: null };
        calls.finds.push(query);
        const chain = {
          sort: (s) => ((query.sort = s), chain),
          skip: (n) => ((query.skip = n), chain),
          limit: (n) => ((query.limit = n), chain),
          lean: async () => rowsByCall.rows,
        };
        return chain;
      }),
    };
  }

  test("counts every tab, reads only the chosen one, maps rows", async () => {
    const model = fakeModel({ counts: [4, 1, 0, 2], rows: [reservation()] });
    const result = await trips.listTrips({ ReservationModel: model }, guestId, {
      tab: "upcoming",
      page: "1",
      now: NOW,
    });
    expect(model.countDocuments).toHaveBeenCalledTimes(4);
    expect(model.find).toHaveBeenCalledTimes(1);
    expect(result.tabs.map((t) => [t.key, t.count])).toEqual([
      ["upcoming", 4],
      ["pending", 1],
      ["past", 0],
      ["cancelled", 2],
    ]);
    expect(result.total).toBe(4);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].listingTitle).toBe("Sea house");
    expect(model.calls.finds[0].filter.guest).toBe(guestId);
    expect(model.calls.finds[0]).toMatchObject({
      skip: 0,
      limit: trips.PAGE_SIZE,
    });
  });

  test("an empty tab does not query for rows", async () => {
    const model = fakeModel({ counts: [0, 0, 0, 0], rows: [] });
    const result = await trips.listTrips({ ReservationModel: model }, guestId, {
      tab: "past",
      now: NOW,
    });
    expect(model.find).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.totalPages).toBe(1);
  });

  test("paging: skip follows the page, a page past the end is the last page", async () => {
    const model = fakeModel({ counts: [25, 0, 0, 0], rows: [] });
    await trips.listTrips({ ReservationModel: model }, guestId, {
      tab: "upcoming",
      page: "2",
      now: NOW,
    });
    expect(model.calls.finds[0].skip).toBe(trips.PAGE_SIZE);
    const again = fakeModel({ counts: [25, 0, 0, 0], rows: [] });
    const result = await trips.listTrips({ ReservationModel: again }, guestId, {
      tab: "upcoming",
      page: "99",
      now: NOW,
    });
    expect(result.page).toBe(3);
    expect(again.calls.finds[0].skip).toBe(2 * trips.PAGE_SIZE);
  });

  test("a bad tab falls back to upcoming", async () => {
    const model = fakeModel({ counts: [0, 0, 0, 0], rows: [] });
    expect(
      (
        await trips.listTrips({ ReservationModel: model }, guestId, {
          tab: "x",
          now: NOW,
        })
      ).tab,
    ).toBe("upcoming");
  });
});
