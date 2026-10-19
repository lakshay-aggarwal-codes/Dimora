// P07-T04: the nights of one listing that a guest cannot book (dates only).
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");

const id = () => new mongoose.Types.ObjectId();
const day = (text) => new Date(`${text}T00:00:00Z`);
const NOW = new Date("2026-10-20T10:00:00Z");

function build(rows) {
  const model = { find: jest.fn(() => ({ lean: () => Promise.resolve(rows) })) };
  return { model, service: createLedgerService({ model }) };
}

describe("unavailableDates", () => {
  test("asks for one listing and [from, to) only", async () => {
    const listing = id();
    const { model, service } = build([]);
    await service.unavailableDates(listing, day("2026-12-01"), day("2026-12-31"), { now: NOW });
    expect(model.find.mock.calls[0][0]).toEqual({
      listing,
      date: { $gte: day("2026-12-01"), $lt: day("2026-12-31") },
    });
  });

  test("returns dates oldest first and never who holds them", async () => {
    const { service } = build([
      { date: day("2026-12-05"), source: { kind: "reservation", id: id() }, guest: "secret" },
      { date: day("2026-12-02"), source: { kind: "block", id: id() } },
    ]);
    const result = await service.unavailableDates(id(), day("2026-12-01"), day("2026-12-31"), {
      now: NOW,
    });
    expect(result).toEqual([day("2026-12-02"), day("2026-12-05")]);
    expect(result.every((d) => d instanceof Date)).toBe(true);
  });

  test("a block and a reservation look the same; an expired hold is free", async () => {
    const { service } = build([
      { date: day("2026-12-02"), source: { kind: "block", id: id() } },
      { date: day("2026-12-03"), source: { kind: "reservation", id: id() } },
      { date: day("2026-12-04"), source: { kind: "reservation", id: id() }, holdExpiresAt: new Date("2026-10-21T00:00:00Z") },
      { date: day("2026-12-05"), source: { kind: "reservation", id: id() }, holdExpiresAt: new Date("2026-10-19T00:00:00Z") },
    ]);
    const result = await service.unavailableDates(id(), day("2026-12-01"), day("2026-12-31"), {
      now: NOW,
    });
    expect(result).toEqual([day("2026-12-02"), day("2026-12-03"), day("2026-12-04")]);
  });

  test("rejects bad input", async () => {
    const { service } = build([]);
    await expect(service.unavailableDates("nope", day("2026-12-01"), day("2026-12-02"))).rejects.toThrow(TypeError);
    await expect(service.unavailableDates(id(), new Date("2026-12-01T05:00:00Z"), day("2026-12-02"))).rejects.toThrow(TypeError);
    await expect(service.unavailableDates(id(), day("2026-12-02"), day("2026-12-02"))).rejects.toThrow(TypeError);
    await expect(service.unavailableDates(id(), day("2026-01-01"), day("2027-03-01"))).rejects.toThrow(TypeError);
  });
});
