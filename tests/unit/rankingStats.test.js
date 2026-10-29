// P15-T06: the click-through counters, with a fake ListingStat.
const assert = require("node:assert/strict");
const { VARIANTS, recordShown, recordClick, summary } = require("../../src/services/rankingStats");

const READY = () => true;
function fake() {
  const calls = { bulk: [], update: [], aggregate: [] };
  return {
    calls,
    bulkWrite: async (ops, opts) => calls.bulk.push({ ops, opts }),
    updateOne: async (...a) => calls.update.push(a),
    aggregate: async (p) => (calls.aggregate.push(p), fake.row ? [fake.row] : []),
  };
}

test("the variants are the default order and the three purposes", () => {
  assert.deepEqual([...VARIANTS], ["default", "work", "family", "weekend"]);
});

test("shown: one upsert per listing, incrementing only that variant's counter", async () => {
  const m = fake();
  await recordShown({ ListingStat: m, ids: ["a", "b"], variant: "work", ready: READY });
  const [{ ops, opts }] = m.calls.bulk;
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].updateOne.filter, { listing: "a" });
  assert.deepEqual(ops[0].updateOne.update, { $inc: { "ranking.work.shown": 1 } });
  assert.equal(ops[0].updateOne.upsert, true);
  assert.equal(opts.ordered, false);
});

test("nothing is written for an unknown variant, no ids, or a database that is not connected", async () => {
  const m = fake();
  await recordShown({ ListingStat: m, ids: ["a"], variant: "price_asc", ready: READY });
  await recordShown({ ListingStat: m, ids: ["a"], variant: "constructor", ready: READY });
  await recordShown({ ListingStat: m, ids: [], variant: "work", ready: READY });
  await recordShown({ ListingStat: m, ids: undefined, variant: "work", ready: READY });
  await recordShown({ ListingStat: m, ids: ["a"], variant: "work", ready: () => false });
  await recordClick({ ListingStat: m, listingId: "a", variant: "nope", ready: READY });
  await recordClick({ ListingStat: m, listingId: "a", variant: "work", ready: () => false });
  assert.equal(m.calls.bulk.length + m.calls.update.length, 0);
});

test("click: one increment of that variant's clicked counter", async () => {
  const m = fake();
  await recordClick({ ListingStat: m, listingId: "a", variant: "default", ready: READY });
  assert.deepEqual(m.calls.update[0], [{ listing: "a" }, { $inc: { "ranking.default.clicked": 1 } }, { upsert: true }]);
});

test("summary adds up every listing and gives the rate, or null with nothing shown", async () => {
  const m = fake();
  fake.row = { default_shown: 200, default_clicked: 10, work_shown: 50, work_clicked: 5, family_shown: 0, family_clicked: 0, weekend_shown: 4 };
  const rows = await summary({ ListingStat: m });
  const by = Object.fromEntries(rows.map((r) => [r.variant, r]));
  assert.equal(by.default.ctr, 0.05);
  assert.equal(by.work.ctr, 0.1);
  assert.equal(by.family.ctr, null);
  assert.equal(by.weekend.clicked, 0);
  fake.row = null;
  const empty = await summary({ ListingStat: fake() });
  assert.ok(empty.every((r) => r.shown === 0 && r.ctr === null));
});
