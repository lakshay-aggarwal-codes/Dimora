// In-memory stand-in for the StayNight model, used by the ledger unit tests
// (no mongod). It mimics what the service relies on: ordered insertMany that
// stops at the first duplicate (listing, date) and keeps earlier rows, and
// deleteMany/find with the few filter operators the service uses.
//
// insertMany yields between documents so concurrent callers interleave, and
// each uniqueness check + push is atomic (like a unique index). This proves the
// service's LOGIC (compensation, takeover, ordering); it does not prove
// MongoDB behaviour: tests/integration/ledger.db.test.js does that.
let counter = 0;

/** A fake 24-hex-character id (string), unique per call. */
function fakeId() {
  counter += 1;
  return counter.toString(16).padStart(24, "0");
}

const keyOf = (value) =>
  value instanceof Date ? value.getTime() : String(value);

function getPath(row, path) {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), row);
}

function matches(row, filter) {
  return Object.entries(filter).every(([path, condition]) => {
    const value = getPath(row, path);
    const isOperators =
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date) &&
      Object.keys(condition).some((k) => k.startsWith("$"));
    if (!isOperators) return keyOf(value) === keyOf(condition);
    return Object.entries(condition).every(([op, operand]) => {
      if (op === "$in") return operand.map(keyOf).includes(keyOf(value));
      if (value == null) return false; // missing fields never match ranges
      const v = keyOf(value);
      const o = keyOf(operand);
      if (op === "$lt") return v < o;
      if (op === "$lte") return v <= o;
      if (op === "$gt") return v > o;
      if (op === "$gte") return v >= o;
      throw new Error(`fake model: unsupported operator ${op}`);
    });
  });
}

class FakeStayNight {
  constructor() {
    this.rows = [];
    // Set to N to make insertMany throw a non-duplicate error after N rows.
    this.failInsertAfter = null;
    this.deleteManyFailure = null;
  }

  async insertMany(docs) {
    let inserted = 0;
    for (const doc of docs) {
      await Promise.resolve();
      if (this.failInsertAfter !== null && inserted >= this.failInsertAfter) {
        throw new Error("simulated database failure");
      }
      const taken = this.rows.some(
        (r) =>
          keyOf(r.listing) === keyOf(doc.listing) &&
          keyOf(r.date) === keyOf(doc.date),
      );
      if (taken) {
        const err = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
      this.rows.push({ ...doc });
      inserted += 1;
    }
    return docs;
  }

  async deleteMany(filter) {
    await Promise.resolve();
    if (this.deleteManyFailure) throw this.deleteManyFailure;
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, filter));
    return { deletedCount: before - this.rows.length };
  }

  find(filter) {
    const rows = this.rows.filter((row) => matches(row, filter));
    return { lean: async () => rows.map((row) => ({ ...row })) };
  }
}

module.exports = { FakeStayNight, fakeId };
