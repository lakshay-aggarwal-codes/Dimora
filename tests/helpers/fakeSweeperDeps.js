// In-memory stand-ins for the sweeper's unit tests (P07-T07): reservations that
// can be listed (`find` with sort/limit/select/lean), a night ledger that keeps
// `_id` and `createdAt` on every row, and a StayNight model over that ledger.
// They mimic only what src/services/sweeper.js uses. Real MongoDB behaviour
// (compare-and-set between parallel sweepers) is covered by
// tests/integration/sweeper.db.test.js.
const {
  FakeReservationModel,
  FakeLedger,
  fakeId,
} = require("./fakeReservationDeps");

const keyOf = (v) =>
  v instanceof Date ? v.getTime() : v && v._id ? String(v._id) : String(v);
const getPath = (row, path) =>
  path.split(".").reduce((v, k) => (v == null ? v : v[k]), row);

function matches(row, filter) {
  return Object.entries(filter).every(([path, cond]) => {
    const value = getPath(row, path);
    const isOps =
      cond &&
      typeof cond === "object" &&
      !(cond instanceof Date) &&
      Object.keys(cond).some((k) => k.startsWith("$"));
    if (!isOps) return keyOf(value) === keyOf(cond);
    return Object.entries(cond).every(([op, operand]) => {
      if (op === "$in") return operand.map(keyOf).includes(keyOf(value));
      if (value === undefined || value === null) return false;
      const a = keyOf(value);
      const b = keyOf(operand);
      if (op === "$gt") return a > b;
      if (op === "$gte") return a >= b;
      if (op === "$lt") return a < b;
      if (op === "$lte") return a <= b;
      throw new Error(`fake: unsupported operator ${op}`);
    });
  });
}

// A thenable query: .sort().limit().select().lean() and await.
class Query {
  constructor(rows) {
    this.rows = rows;
  }
  sort(spec) {
    const [[field, dir]] = Object.entries(spec);
    this.rows = [...this.rows].sort((x, y) => {
      const a = keyOf(getPath(x, field));
      const b = keyOf(getPath(y, field));
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    });
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  select() {
    return this;
  }
  lean() {
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve(this.rows.map((r) => ({ ...r }))).then(
      resolve,
      reject,
    );
  }
}

class SweeperReservationModel extends FakeReservationModel {
  find(filter = {}) {
    return new Query(this.docs.filter((d) => matches(d, filter)));
  }
}

/** The ledger fake, with `_id` and `createdAt` on every row it writes. */
class StampedLedger extends FakeLedger {
  constructor(clock = () => new Date()) {
    super();
    this.clock = clock;
  }
  async reserveNights(listing, nights, source, hold, opts) {
    const before = this.rows.length;
    const result = await super.reserveNights(
      listing,
      nights,
      source,
      hold,
      opts,
    );
    for (const row of this.rows.slice(before)) {
      row._id = fakeId();
      row.createdAt = this.clock();
    }
    return result;
  }
}

/** The StayNight model over a ledger's rows. */
class FakeNightModel {
  constructor(ledger) {
    this.ledger = ledger;
  }
  find(filter = {}) {
    return new Query(this.ledger.rows.filter((r) => matches(r, filter)));
  }
  async deleteMany(filter) {
    const gone = this.ledger.rows.filter((r) => matches(r, filter));
    this.ledger.rows = this.ledger.rows.filter((r) => !gone.includes(r));
    return { deletedCount: gone.length };
  }
}

/** Blocks: only `find({ _id: { $in } })` is used. */
class FakeBlockModel {
  constructor(ids = []) {
    this.docs = ids.map((id) => ({ _id: id }));
  }
  find(filter = {}) {
    return new Query(this.docs.filter((d) => matches(d, filter)));
  }
}

module.exports = {
  SweeperReservationModel,
  StampedLedger,
  FakeNightModel,
  FakeBlockModel,
  fakeId,
  matches,
};
