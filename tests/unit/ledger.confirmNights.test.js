// P07-T05: accepting a request removes the hold from its nights.
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");

describe("confirmNights", () => {
  test("unsets the hold on the rows of that reservation only", async () => {
    const model = { updateMany: jest.fn(async () => ({ modifiedCount: 3 })) };
    const service = createLedgerService({ model });
    const id = new mongoose.Types.ObjectId();
    await expect(service.confirmNights(id)).resolves.toEqual({ confirmed: 3 });
    expect(model.updateMany).toHaveBeenCalledWith({ "source.id": id }, { $unset: { holdExpiresAt: 1 } });
  });

  test("a bad id is refused before any write", async () => {
    const model = { updateMany: jest.fn() };
    const service = createLedgerService({ model });
    await expect(service.confirmNights("nope")).rejects.toThrow(TypeError);
    expect(model.updateMany).not.toHaveBeenCalled();
  });
});
