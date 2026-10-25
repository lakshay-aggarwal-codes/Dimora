// P11-T04: the event -> recipients -> text table, and the dispatcher that
// sends it. Pure: no database.
const { plan, createNotifier, EVENT_NAMES, clip } = require("../../src/services/notificationEvents");
const { TYPE_PATTERN, LIMITS, REF_KINDS } = require("../../src/config/notifications");
const { safeRedirectPath } = require("../../src/utils/safeRedirect");

const RES = "a".repeat(24);
const GUEST = "b".repeat(24);
const HOST = "c".repeat(24);
const LISTING = "d".repeat(24);

const reservation = (over = {}) => ({
  _id: RES,
  guest: GUEST,
  host: HOST,
  listing: LISTING,
  checkIn: new Date("2026-11-12T00:00:00Z"),
  checkOut: new Date("2026-11-15T00:00:00Z"),
  nights: 3,
  guests: 2,
  listingSnapshot: { title: "Sea house" },
  ...over,
});
const listing = { _id: LISTING, owner: HOST, title: "Sea house" };

// event, context, then who is told (in order): [recipient, type, title, link, text the body must contain]
const TABLE = [
  ["reservation.requested", { reservation: reservation() }, [
    [HOST, "reservation.requested", "New booking request: Sea house", "/host/reservations", "12 Nov 2026 to 15 Nov 2026 (3 nights, 2 guests)"],
  ]],
  ["reservation.booked", { reservation: reservation() }, [
    [HOST, "reservation.booked", "New booking: Sea house", "/host/reservations", "confirmed instantly"],
  ]],
  ["reservation.accepted", { reservation: reservation() }, [
    [GUEST, "reservation.accepted", "Booking confirmed: Sea house", `/trips/${RES}`, "The host accepted your request"],
  ]],
  ["reservation.declined", { reservation: reservation() }, [
    [GUEST, "reservation.declined", "Request declined: Sea house", `/trips/${RES}`, "The host declined your request"],
  ]],
  ["reservation.expired", { reservation: reservation() }, [
    [GUEST, "reservation.expired", "Request expired: Sea house", `/trips/${RES}`, "did not answer in time"],
    [HOST, "reservation.expired", "A request expired: Sea house", "/host/reservations", "You did not answer"],
  ]],
  ["reservation.cancelled", { reservation: reservation({ cancelledBy: "guest" }) }, [
    [HOST, "reservation.cancelled", "Booking cancelled: Sea house", "/host/reservations", "The guest cancelled"],
  ]],
  ["reservation.cancelled", { reservation: reservation({ cancelledBy: "host", cancelReason: "Burst pipe" }) }, [
    [GUEST, "reservation.cancelled", "Booking cancelled by the host: Sea house", `/trips/${RES}`, "Reason: Burst pipe"],
  ]],
  ["reservation.checkin_tomorrow", { reservation: reservation() }, [
    [GUEST, "reservation.checkin_tomorrow", "Check-in tomorrow: Sea house", `/trips/${RES}`, "starts 12 Nov 2026"],
    [HOST, "reservation.checkin_tomorrow", "Guest arriving tomorrow: Sea house", "/host/reservations", "checks in on 12 Nov 2026"],
  ]],
  ["review.available", { reservation: reservation() }, [
    [GUEST, "review.available", "How was Sea house?", `/trips/${RES}#review`, "You can leave a review"],
  ]],
  ["listing.suspended", { listing, reason: "Photos are not of this place" }, [
    [HOST, "listing.suspended", "Your listing was suspended: Sea house", `/host/listings/${LISTING}/status`, "Reason: Photos are not of this place"],
  ]],
  ["listing.restored", { listing }, [
    [HOST, "listing.restored", "Your listing is visible again: Sea house", `/host/listings/${LISTING}/status`, "restored"],
  ]],
];

describe("event -> recipients -> text", () => {
  test.each(TABLE.map((row) => [`${row[0]}${row[1].reservation && row[1].reservation.cancelledBy ? ` by ${row[1].reservation.cancelledBy}` : ""}`, ...row]))(
    "%s",
    (_label, event, ctx, expected) => {
      const got = plan(event, ctx);
      expect(got.map((p) => p.userId)).toEqual(expected.map((e) => e[0]));
      got.forEach((p, i) => {
        const [, type, title, url, body] = expected[i];
        expect(p.type).toBe(type);
        expect(p.payload.title).toBe(title);
        expect(p.payload.url).toBe(url);
        expect(p.payload.body).toContain(body);
      });
    },
  );

  test("every event the module knows is in the table", () => {
    expect([...new Set(TABLE.map((row) => row[0]))].sort()).toEqual([...EVENT_NAMES].sort());
  });

  test("everything planned is acceptable to the notification service", () => {
    for (const [event, ctx] of TABLE) {
      for (const p of plan(event, ctx)) {
        expect(p.userId).toMatch(/^[0-9a-f]{24}$/);
        expect(p.type).toMatch(TYPE_PATTERN);
        expect(p.type.length).toBeLessThanOrEqual(LIMITS.type);
        expect(REF_KINDS).toContain(p.ref.kind);
        expect(p.ref.id).toMatch(/^[0-9a-f]{24}$/);
        expect(p.payload.title.length).toBeLessThanOrEqual(LIMITS.title);
        expect(p.payload.body.length).toBeLessThanOrEqual(LIMITS.body);
        expect(safeRedirectPath(p.payload.url, null)).toBe(p.payload.url);
      }
    }
  });

  test("nobody is told about their own action, and the two sides are never swapped", () => {
    // guest cancels -> only the host; host cancels -> only the guest
    const byGuest = plan("reservation.cancelled", { reservation: reservation({ cancelledBy: "guest" }) });
    const byHost = plan("reservation.cancelled", { reservation: reservation({ cancelledBy: "host" }) });
    expect(byGuest.map((p) => p.userId)).toEqual([HOST]);
    expect(byHost.map((p) => p.userId)).toEqual([GUEST]);
    expect(plan("reservation.cancelled", { reservation: reservation({ cancelledBy: "system" }) })).toEqual([]);
    expect(plan("reservation.cancelled", { reservation: reservation() })).toEqual([]);
    // a request goes to the host, an answer to the guest
    expect(plan("reservation.requested", { reservation: reservation() }).map((p) => p.userId)).toEqual([HOST]);
    expect(plan("reservation.accepted", { reservation: reservation() }).map((p) => p.userId)).toEqual([GUEST]);
    // only the reviewing side hears "review available"
    expect(plan("review.available", { reservation: reservation() }).map((p) => p.userId)).toEqual([GUEST]);
  });

  test("ids may be ObjectId-like or populated documents", () => {
    const oid = (hex) => ({ toHexString: () => hex, toString: () => hex });
    const got = plan("reservation.accepted", {
      reservation: reservation({ _id: oid(RES), guest: { _id: GUEST, username: "ann" }, host: oid(HOST) }),
    });
    expect(got[0].userId).toBe(GUEST);
    expect(got[0].ref.id).toBe(RES);
    expect(got[0].payload.url).toBe(`/trips/${RES}`);
  });

  test("a hostile or very long title and reason are cut to one safe line", () => {
    const nasty = `Evil\u0000\nhouse ${"x".repeat(300)}<script>`;
    const got = plan("reservation.cancelled", {
      reservation: reservation({
        cancelledBy: "host",
        cancelReason: `bad\r\n${"y".repeat(900)}`,
        listingSnapshot: { title: nasty },
      }),
    });
    const { title, body } = got[0].payload;
    expect(title.length).toBeLessThanOrEqual(LIMITS.title);
    expect(body.length).toBeLessThanOrEqual(LIMITS.body);
    // eslint-disable-next-line no-control-regex
    expect(title + body).not.toMatch(/[\u0000-\u001f]/);
    expect(title.startsWith("Booking cancelled by the host: Evil house")).toBe(true);
  });

  test("a missing listing title falls back to a plain phrase", () => {
    const got = plan("reservation.accepted", { reservation: reservation({ listingSnapshot: undefined }) });
    expect(got[0].payload.title).toBe("Booking confirmed: your stay");
  });

  test("an unknown event is a programming error", () => {
    expect(() => plan("reservation.exploded", {})).toThrow(/Unknown notification event/);
    expect(() => plan("__proto__", {})).toThrow(/Unknown notification event/);
    expect(() => plan("toString", {})).toThrow(/Unknown notification event/);
  });

  test("a suspended listing with no reason or owner says no reason and tells nobody", () => {
    const noReason = plan("listing.suspended", { listing, reason: "" });
    expect(noReason[0].payload.body).toBe("It is no longer visible to guests.");
    expect(plan("listing.suspended", { listing: { ...listing, owner: null }, reason: "x" })).toEqual([]);
  });
});

describe("clip", () => {
  test("one line, at most `max` characters, with an ellipsis when cut", () => {
    expect(clip("  a \n\t b  ", 10)).toBe("a b");
    expect(clip("abcdefghij", 10)).toBe("abcdefghij");
    expect(clip("abcdefghijk", 10)).toBe("abcdefghi\u2026");
    expect(clip(undefined, 5)).toBe("");
  });
});

describe("dispatch", () => {
  const quiet = { warn: () => {} };
  const calls = [];
  const notify = async (...args) => {
    calls.push(args);
  };
  beforeEach(() => {
    calls.length = 0;
  });

  test("sends each planned notification with its recipient, type, reference and text", async () => {
    const { dispatch } = createNotifier({ notify, connected: () => true, logger: quiet });
    const n = await dispatch("reservation.expired", { reservation: reservation() });
    expect(n).toBe(2);
    expect(calls.map((c) => c[0])).toEqual([GUEST, HOST]);
    expect(calls[0][1]).toBe("reservation.expired");
    expect(calls[0][2]).toEqual({ kind: "reservation", id: RES });
    expect(calls[0][3].title).toBe("Request expired: Sea house");
  });

  test("a failed notification does not stop the next and does not throw", async () => {
    const warnings = [];
    let first = true;
    const { dispatch } = createNotifier({
      notify: async (...args) => {
        if (first) {
          first = false;
          throw new Error("disk full");
        }
        calls.push(args);
      },
      connected: () => true,
      logger: { warn: (m) => warnings.push(m) },
    });
    await expect(dispatch("reservation.expired", { reservation: reservation() })).resolves.toBe(1);
    expect(calls.map((c) => c[0])).toEqual([HOST]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/disk full/);
  });

  test("an unknown event or a broken context is logged, never thrown", async () => {
    const warnings = [];
    const { dispatch } = createNotifier({ notify, connected: () => true, logger: { warn: (m) => warnings.push(m) } });
    await expect(dispatch("nope", {})).resolves.toBe(0);
    await expect(dispatch("reservation.accepted", undefined)).resolves.toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  test("with no database connection nothing is sent", async () => {
    const { dispatch } = createNotifier({ notify, connected: () => false, logger: quiet });
    await expect(dispatch("reservation.accepted", { reservation: reservation() })).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});
