// P04-T05: the ledger's "is there an upcoming reservation?" question.
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");

const id = () => new mongoose.Types.ObjectId();
function build(found) {
  const model = { exists: jest.fn().mockResolvedValue(found) };
  return { model, service: createLedgerService({ model }) };
}

describe("hasUpcomingReservation", () => {
  const now = new Date("2026-10-17T20:00:00Z"); // already the 18th in India

  test("asks for reservation rows from today (listing time zone) onward", async () => {
    const { model, service } = build({ _id: 1 });
    const listing = id();
    expect(
      await service.hasUpcomingReservation(listing, {
        now,
        timeZone: "Asia/Kolkata",
      }),
    ).toBe(true);
    const query = model.exists.mock.calls[0][0];
    expect(query.listing).toBe(listing);
    expect(query["source.kind"]).toBe("reservation");
    expect(query.date.$gte.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  test("the time zone changes what 'today' is", async () => {
    const { model, service } = build(null);
    await service.hasUpcomingReservation(id(), {
      now,
      timeZone: "America/Los_Angeles",
    });
    expect(model.exists.mock.calls[0][0].date.$gte.toISOString()).toBe(
      "2026-10-17T00:00:00.000Z",
    );
  });

  test("an expired hold does not count; a confirmed row (no hold) does", async () => {
    const { model, service } = build(null);
    await service.hasUpcomingReservation(id(), { now });
    expect(model.exists.mock.calls[0][0].$or).toEqual([
      { holdExpiresAt: null },
      { holdExpiresAt: { $gt: now } },
    ]);
  });

  test("no row means false", async () => {
    const { service } = build(null);
    expect(await service.hasUpcomingReservation(id(), { now })).toBe(false);
  });

  test("host blocks are not reservations", async () => {
    const { model, service } = build(null);
    await service.hasUpcomingReservation(id(), { now });
    expect(model.exists.mock.calls[0][0]["source.kind"]).not.toBe("block");
  });

  test("a bad listing id is a programming error", async () => {
    const { service } = build(null);
    await expect(service.hasUpcomingReservation("nope")).rejects.toThrow(
      TypeError,
    );
  });
});
