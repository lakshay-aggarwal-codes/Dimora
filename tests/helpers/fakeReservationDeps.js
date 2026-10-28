// In-memory stand-ins for the Reservation model, the Listing model and the
// ledger service, for the reservation service's unit tests (no mongod). They
// mimic only what the service uses. Real MongoDB behaviour (unique indexes,
// compare-and-set under concurrency) is covered by
// tests/integration/reservations.db.test.js.
const { ConflictError } = require("../../src/utils/errors");

let counter = 0;
const fakeId = () => {
  counter += 1;
  return counter.toString(16).padStart(24, "0");
};

const val = (v) => (v instanceof Date ? v.getTime() : v && v._id ? String(v._id) : String(v));
const getPath = (row, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), row);

function matches(row, filter) {
  return Object.entries(filter).every(([path, cond]) => {
    const v = getPath(row, path);
    const ops = cond && typeof cond === "object" && !(cond instanceof Date) && Object.keys(cond).some((k) => k.startsWith("$"));
    if (!ops) return val(v) === val(cond);
    return Object.entries(cond).every(([op, operand]) => {
      if (v === undefined || v === null) return false;
      const a = val(v);
      const b = val(operand);
      if (op === "$gt") return a > b;
      if (op === "$gte") return a >= b;
      if (op === "$lt") return a < b;
      if (op === "$lte") return a <= b;
      throw new Error(`fake: unsupported operator ${op}`);
    });
  });
}

class FakeReservationModel {
  constructor() {
    this.docs = [];
    this.createFailure = null; // set to an Error to make the next create() throw
  }

  async create(doc) {
    await Promise.resolve();
    if (this.createFailure) {
      const err = this.createFailure;
      this.createFailure = null;
      throw err;
    }
    if (this.docs.some((d) => val(d.guest) === val(doc.guest) && d.idempotencyKey === doc.idempotencyKey)) {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    const copy = { ...doc };
    this.docs.push(copy);
    return copy;
  }

  async findOne(filter) {
    await Promise.resolve();
    return this.docs.find((d) => matches(d, filter)) || null;
  }

  async findById(id) {
    await Promise.resolve();
    return this.docs.find((d) => val(d._id) === val(id)) || null;
  }

  async findOneAndUpdate(filter, update) {
    await Promise.resolve();
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    for (const [key, entry] of Object.entries(update.$push || {})) doc[key] = [...(doc[key] || []), entry];
    return doc;
  }
}

class FakeListingModel {
  constructor(listings = []) {
    this.listings = listings;
    this.afterFirstRead = null; // runs once after the first findById (simulates a concurrent change)
    this.reads = 0;
  }

  findById(id) {
    const run = async () => {
      await Promise.resolve();
      this.reads += 1;
      const found = this.listings.find((l) => val(l._id) === val(id)) || null;
      if (this.reads === 1 && this.afterFirstRead) this.afterFirstRead(found);
      return found;
    };
    const promise = () => run();
    return { select: () => promise(), then: (a, b) => promise().then(a, b) };
  }
}

class FakeLedger {
  constructor() {
    this.rows = [];
    this.failRelease = false;
  }

  async reserveNights(listing, nights, source, holdExpiresAt = null, { now = new Date() } = {}) {
    await Promise.resolve();
    const stale = (r) => r.holdExpiresAt && r.holdExpiresAt.getTime() < now.getTime();
    this.rows = this.rows.filter(
      (r) => !(val(r.listing) === val(listing) && nights.some((n) => n.getTime() === r.date.getTime()) && stale(r)),
    );
    const clash = nights.filter((n) => this.rows.some((r) => val(r.listing) === val(listing) && r.date.getTime() === n.getTime()));
    if (clash.length) {
      const err = new ConflictError("These nights are no longer available.", { code: "nights_unavailable" });
      err.conflictingDates = clash;
      throw err;
    }
    for (const date of nights) {
      this.rows.push({ listing, date, source, ...(holdExpiresAt ? { holdExpiresAt } : {}) });
    }
    return { reserved: nights.length, nights };
  }

  async releaseNights(sourceId) {
    if (this.failRelease) throw new Error("release failed");
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => val(r.source.id) !== val(sourceId));
    return { released: before - this.rows.length };
  }

  // Change of dates (P09-T04): only rows of ONE source are touched.
  async releaseNightsOn(sourceId, nights) {
    if (this.failReleaseOn) throw new Error("release failed");
    const wanted = new Set(nights.map((n) => n.getTime()));
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(val(r.source.id) === val(sourceId) && wanted.has(r.date.getTime())),
    );
    return { released: before - this.rows.length };
  }

  async trimNights(sourceId, keep) {
    if (this.failTrim) throw new Error("trim failed");
    const wanted = new Set(keep.map((n) => n.getTime()));
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(val(r.source.id) === val(sourceId) && !wanted.has(r.date.getTime())),
    );
    return { released: before - this.rows.length };
  }

  async extendHold(sourceId, holdExpiresAt) {
    if (this.failExtend) throw new Error("extend failed");
    let n = 0;
    for (const r of this.rows) {
      if (val(r.source.id) === val(sourceId) && r.holdExpiresAt) {
        r.holdExpiresAt = holdExpiresAt;
        n += 1;
      }
    }
    return { extended: n };
  }

  async unavailableDates(listing, from, to, { now = new Date() } = {}) {
    return this.rows
      .filter(
        (r) =>
          val(r.listing) === val(listing) &&
          r.date.getTime() >= from.getTime() &&
          r.date.getTime() < to.getTime() &&
          !(r.holdExpiresAt && r.holdExpiresAt.getTime() < now.getTime()),
      )
      .map((r) => r.date)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  async confirmNights(sourceId) {
    let n = 0;
    for (const r of this.rows) {
      if (val(r.source.id) === val(sourceId) && r.holdExpiresAt) {
        delete r.holdExpiresAt;
        n += 1;
      }
    }
    return { confirmed: n };
  }
}

module.exports = { FakeReservationModel, FakeListingModel, FakeLedger, fakeId };
