// P04-T02: deleting drafts nobody has touched for 90 days.
const { deleteStaleDrafts, DEFAULT_DAYS } = require("../../src/services/drafts");

const NOW = new Date("2026-10-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function fakeModel(drafts, { deletes = true } = {}) {
  const calls = { find: [], deleteOne: [] };
  return {
    calls,
    find(filter) {
      calls.find.push(filter);
      return { select: () => ({ lean: async () => drafts }) };
    },
    async deleteOne(filter) {
      calls.deleteOne.push(filter);
      return { deletedCount: deletes ? 1 : 0 };
    },
  };
}

test("the default is 90 days and only drafts older than that are looked for", async () => {
  const model = fakeModel([]);
  await deleteStaleDrafts(model, { now: NOW });
  expect(DEFAULT_DAYS).toBe(90);
  const filter = model.calls.find[0];
  expect(filter.status).toBe("draft");
  expect(filter.updatedAt.$lt).toEqual(new Date(NOW.getTime() - 90 * DAY));
});

test("each stale draft is deleted with the same guard, and its photos are removed", async () => {
  const model = fakeModel([
    { _id: "a", images: [{ publicId: "dimora_DEV/1" }, { publicId: "dimora_DEV/2" }] },
    { _id: "b", images: [] },
  ]);
  const destroyed = [];
  const result = await deleteStaleDrafts(model, {
    now: NOW,
    destroy: async (id) => destroyed.push(id),
  });
  expect(result).toEqual({ deleted: 2, photosRemoved: 2 });
  expect(destroyed).toEqual(["dimora_DEV/1", "dimora_DEV/2"]);
  expect(model.calls.deleteOne[0]).toMatchObject({ _id: "a", status: "draft" });
  expect(model.calls.deleteOne[0].updatedAt.$lt).toBeInstanceOf(Date);
});

test("a draft that changed meanwhile (the delete matched nothing) keeps its photos", async () => {
  const model = fakeModel([{ _id: "a", images: [{ publicId: "dimora_DEV/1" }] }], {
    deletes: false,
  });
  const destroyed = [];
  const result = await deleteStaleDrafts(model, {
    now: NOW,
    destroy: async (id) => destroyed.push(id),
  });
  expect(result).toEqual({ deleted: 0, photosRemoved: 0 });
  expect(destroyed).toEqual([]);
});

test("a photo that cannot be removed does not stop the clean-up", async () => {
  const model = fakeModel([
    { _id: "a", images: [{ publicId: "dimora_DEV/1" }, { publicId: "dimora_DEV/2" }] },
  ]);
  const result = await deleteStaleDrafts(model, {
    now: NOW,
    destroy: async (id) => {
      if (id === "dimora_DEV/1") throw new Error("cloudinary down");
    },
  });
  expect(result).toEqual({ deleted: 1, photosRemoved: 1 });
});

test("without a destroy function only the rows are deleted; no drafts is fine", async () => {
  expect(await deleteStaleDrafts(fakeModel([{ _id: "a" }]), { now: NOW })).toEqual({
    deleted: 1,
    photosRemoved: 0,
  });
  expect(await deleteStaleDrafts(fakeModel([]), { now: NOW })).toEqual({
    deleted: 0,
    photosRemoved: 0,
  });
});
