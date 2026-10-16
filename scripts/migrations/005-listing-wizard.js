// Listing wizard (P04-T02): builds the unique index that lets the first wizard
// step be submitted twice (double click, back button) and still make one draft.
// No data changes. Safe to run again.
const INDEX = [
  { owner: 1, draftToken: 1 },
  {
    name: "owner_1_draftToken_1",
    unique: true,
    partialFilterExpression: { draftToken: { $type: "string" } },
  },
];

module.exports = {
  async up(db, ctx = {}) {
    if (ctx.dryRun) return { indexes: 1 };
    await db.collection("listings").createIndex(INDEX[0], INDEX[1]);
    return { indexes: 1 };
  },

  /** Manual rollback (the runner only calls `up`). */
  async down(db) {
    try {
      await db.collection("listings").dropIndex(INDEX[1].name);
    } catch (err) {
      if (!err || err.codeName !== "IndexNotFound") throw err;
    }
    return { indexesDropped: 1 };
  },
};
