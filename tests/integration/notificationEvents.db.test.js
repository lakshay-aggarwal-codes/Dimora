// P11-T04 against a real MongoDB: every planned notification is accepted by the
// real notification service and lands in the right member's inbox. Skipped with
// SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/notificationEvents.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser } = require("../helpers/factories");
const Notification = require("../../src/models/notification");
const { notifier, EVENT_NAMES } = require("../../src/services/notificationEvents");
const notifications = require("../../src/services/notifications");

describeDb("booking events -> notifications (database)", () => {
  useTestDb();

  async function world() {
    const guest = (await createUser()).user;
    const host = (await createUser()).user;
    const other = (await createUser()).user;
    const reservation = {
      _id: host._id, // any ObjectId: only used as the reference
      guest: guest._id,
      host: host._id,
      checkIn: new Date("2026-11-12T00:00:00Z"),
      checkOut: new Date("2026-11-15T00:00:00Z"),
      nights: 3,
      guests: 2,
      listingSnapshot: { title: "Sea house" },
      cancelledBy: "host",
      cancelReason: "Pipe burst",
    };
    const listing = { _id: guest._id, owner: host._id, title: "Sea house" };
    return { guest, host, other, reservation, listing };
  }

  test("every event is stored for exactly the people it names, nobody else", async () => {
    const { guest, host, other, reservation, listing } = await world();
    for (const event of EVENT_NAMES) {
      await Notification.deleteMany({});
      const stored = await notifier.dispatch(event, { reservation, listing, reason: "Photos are not of this place" });
      expect(stored).toBeGreaterThan(0);
      expect(await Notification.countDocuments({})).toBe(stored);
      expect(await notifications.countUnread(other._id)).toBe(0);
      const rows = await Notification.find({}).lean();
      for (const row of rows) {
        expect([String(guest._id), String(host._id)]).toContain(String(row.user));
        expect(row.type).toBe(event);
        expect(row.readAt).toBeNull();
      }
    }
  });

  test("a request goes to the host's inbox, with a link and the dates", async () => {
    const { guest, host, reservation } = await world();
    await notifier.dispatch("reservation.requested", { reservation });
    expect(await notifications.countUnread(guest._id)).toBe(0);
    const { items } = await notifications.listFor(host._id);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("New booking request: Sea house");
    expect(items[0].body).toContain("12 Nov 2026 to 15 Nov 2026");
    expect(items[0].url).toBe("/host/reservations");
  });
});
