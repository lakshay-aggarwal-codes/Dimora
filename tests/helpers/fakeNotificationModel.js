// An in-memory stand-in for the Notification model (P11-T01), with just the
// calls src/services/notifications.js makes. It records every filter, so tests
// can prove that no query is ever sent without a `user`.
function fakeNotificationModel({ start = new Date("2026-10-01T10:00:00Z") } = {}) {
  const rows = [];
  const filters = [];
  let seq = 0;

  const same = (a, b) => String(a) === String(b);
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, wanted]) => {
      if (key === "readAt") {
        return wanted === null ? !row.readAt : same(row.readAt, wanted);
      }
      return same(row[key], wanted);
    });
  const find = (filter) => {
    filters.push(filter);
    return rows.filter((row) => matches(row, filter));
  };
  const hex = (n) => n.toString(16).padStart(24, "0");

  const model = {
    rows,
    filters,
    async create(doc) {
      seq += 1;
      const row = {
        ...doc,
        _id: hex(seq),
        readAt: null,
        createdAt: new Date(start.getTime() + seq * 60000),
      };
      rows.push(row);
      return row;
    },
    async countDocuments(filter) {
      return find(filter).length;
    },
    find(filter) {
      let result = find(filter)
        .slice()
        .sort(
          (a, b) =>
            b.createdAt - a.createdAt || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0),
        );
      const query = {
        sort: () => query,
        skip: (n) => {
          result = result.slice(n);
          return query;
        },
        limit: (n) => {
          result = result.slice(0, n);
          return query;
        },
        lean: async () => result.map((row) => ({ ...row })),
      };
      return query;
    },
    async updateOne(filter, update) {
      const row = find(filter)[0];
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const found = find(filter);
      found.forEach((row) => Object.assign(row, update.$set));
      return { matchedCount: found.length, modifiedCount: found.length };
    },
    async exists(filter) {
      const row = find(filter)[0];
      return row ? { _id: row._id } : null;
    },
  };
  return model;
}

module.exports = { fakeNotificationModel };
