// P11-T05: the notifier emails a copy only of what it stored, in the background,
// and an email problem never changes what dispatch returns.
const { createNotifier } = require("../../src/services/notificationEvents");

const R = (extra = {}) => ({
  _id: "r1",
  guest: "g1",
  host: "h1",
  status: "confirmed",
  nights: 2,
  checkIn: new Date("2099-06-10"),
  checkOut: new Date("2099-06-12"),
  listingSnapshot: { title: "Sea house" },
  ...extra,
});
const quiet = { warn: () => {} };

describe("createNotifier with a mailer", () => {
  test("each stored notification is also handed to the mailer (recipient, type, payload)", async () => {
    const delivered = [];
    const n = createNotifier({
      notify: async () => ({}),
      connected: () => true,
      logger: quiet,
      mailer: { deliver: async (x) => delivered.push(x) },
    });
    expect(await n.dispatch("reservation.accepted", { reservation: R() })).toBe(1);
    await n.idle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].userId).toBe("g1");
    expect(delivered[0].type).toBe("reservation.accepted");
    expect(delivered[0].payload.title).toContain("Sea house");
  });

  test("a notification that could not be stored is not emailed", async () => {
    const delivered = [];
    const n = createNotifier({
      notify: async () => { throw new Error("db down"); },
      connected: () => true,
      logger: quiet,
      mailer: { deliver: async (x) => delivered.push(x) },
    });
    expect(await n.dispatch("reservation.accepted", { reservation: R() })).toBe(0);
    await n.idle();
    expect(delivered).toEqual([]);
  });

  test("a mailer that throws or is slow changes nothing about the count and does not hold dispatch back", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const n = createNotifier({
      notify: async () => ({}),
      connected: () => true,
      logger: quiet,
      mailer: { deliver: async () => { await gate; throw new Error("boom"); } },
    });
    expect(await n.dispatch("reservation.accepted", { reservation: R() })).toBe(1); // returned while the email is still waiting
    release();
    await expect(n.idle()).resolves.toBeUndefined();
  });

  test("no mailer: nothing happens; setMailer turns it on and off", async () => {
    const delivered = [];
    const n = createNotifier({ notify: async () => ({}), connected: () => true, logger: quiet });
    await n.dispatch("reservation.accepted", { reservation: R() });
    n.setMailer({ deliver: async (x) => delivered.push(x) });
    await n.dispatch("reservation.accepted", { reservation: R() });
    await n.idle();
    expect(delivered).toHaveLength(1);
    n.setMailer(null);
    await n.dispatch("reservation.accepted", { reservation: R() });
    await n.idle();
    expect(delivered).toHaveLength(1);
  });

  test("one email per notification: both sides of an expired request", async () => {
    const delivered = [];
    const n = createNotifier({ notify: async () => ({}), connected: () => true, logger: quiet, mailer: { deliver: async (x) => delivered.push(x.userId) } });
    await n.dispatch("reservation.expired", { reservation: R({ status: "expired" }) });
    await n.idle();
    expect(delivered.sort()).toEqual(["g1", "h1"]);
  });
});
