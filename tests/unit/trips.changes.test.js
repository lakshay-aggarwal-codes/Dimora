// P09-T04: what the booking page offers for changing dates (describeTrip).
const { ObjectId } = require("mongoose").Types;
const trips = require("../../src/services/trips");
const { formatMoney } = require("../../src/utils/money");
const { parseDateOnly } = require("../../src/utils/dates");

const NOW = new Date("2026-10-20T06:00:00Z");
const guestId = new ObjectId();
const hostId = new ObjectId();

function booking(extra = {}) {
  return {
    _id: new ObjectId("64b0f0f0f0f0f0f0f0f0abcd"),
    guest: guestId,
    host: hostId,
    listing: { _id: new ObjectId(), title: "Live title", address: {} },
    checkIn: parseDateOnly("2026-11-02"),
    checkOut: parseDateOnly("2026-11-05"),
    nights: 3,
    guests: 2,
    status: "confirmed",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    pricingSnapshot: { lines: [], totalMinor: 800000, currency: "INR" },
    listingSnapshot: { title: "Sea house", checkInTime: "14:00", timezone: "Asia/Kolkata", instantBook: true },
    ...extra,
  };
}
const describe_ = (r, viewerRole = "guest") => trips.describeTrip(r, { viewerRole, formatMoney, now: NOW });

describe("describeTrip: change dates", () => {
  test("the guest of a confirmed future stay is offered the change", () => {
    const t = describe_(booking());
    expect(t.change).toEqual({ url: "/trips/64b0f0f0f0f0f0f0f0f0abcd/change", reapproval: false });
  });

  test("a pending request says it goes back to the host", () => {
    const t = describe_(booking({ status: "pending", holdExpiresAt: new Date("2026-10-21T06:00:00Z") }));
    expect(t.change.reapproval).toBe(true);
  });

  test("on the day of check-in it is offered until the check-in time on the listing's clock", () => {
    const sameDay = booking({ checkIn: parseDateOnly("2026-10-20"), checkOut: parseDateOnly("2026-10-23") });
    expect(describe_(sameDay).change).not.toBeNull(); // 11:30 in Kolkata, check-in is 14:00
  });

  test("no offer for the host, an admin, an expired request, a started stay or a closed booking", () => {
    expect(describe_(booking(), "host").change).toBeNull();
    expect(describe_(booking(), "admin").change).toBeNull();
    expect(describe_(booking({ status: "pending", holdExpiresAt: new Date("2026-10-19T06:00:00Z") })).change).toBeNull();
    expect(describe_(booking({ checkIn: parseDateOnly("2026-10-19"), checkOut: parseDateOnly("2026-10-23") })).change).toBeNull();
    for (const status of ["declined", "expired", "cancelled_by_guest", "cancelled_by_host", "completed"]) {
      expect(describe_(booking({ status })).change).toBeNull();
    }
  });

  test("the history of changes is in words for everyone who may see the booking", () => {
    const r = booking({
      modifications: [
        {
          at: new Date("2026-10-10T06:00:00Z"),
          from: { checkIn: parseDateOnly("2026-11-01"), checkOut: parseDateOnly("2026-11-03") },
          to: { checkIn: parseDateOnly("2026-11-02"), checkOut: parseDateOnly("2026-11-05") },
          differenceMinor: 250000,
          currency: "INR",
          reapproval: true,
        },
        { at: new Date("2026-10-11T06:00:00Z"), from: {}, to: {}, differenceMinor: -50000, currency: "INR" },
        { at: new Date("2026-10-12T06:00:00Z"), from: {}, to: {}, differenceMinor: 0, currency: "INR" },
      ],
    });
    for (const role of ["guest", "host", "admin"]) {
      const t = describe_(r, role);
      expect(t.changes).toHaveLength(3);
      expect(t.changes[0].differenceText).toBe("₹2,500 more");
      expect(t.changes[0].fromText).toMatch(/^1 Nov 2026 to 3 Nov 2026$|1 Nov/);
      expect(t.changes[0].reapproval).toBe(true);
      expect(t.changes[1].differenceText).toBe("₹500 less");
      expect(t.changes[2].differenceText).toBe("same price");
    }
  });

  test("a booking never changed has an empty history", () => {
    expect(describe_(booking()).changes).toEqual([]);
  });
});
