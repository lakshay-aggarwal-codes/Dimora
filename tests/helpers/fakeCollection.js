// A tiny in-memory stand-in for a Mongoose model, enough for the wishlist
// services' unit tests (no mongod). Filters are plain equality on ids and
// values; `unique` lists field sets that must not repeat (a repeat throws a
// duplicate-key error, code 11000, like the real index).
let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, "0");
const same = (a, b) => String(a) === String(b);

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, want]) => {
    if (want && typeof want === "object" && Object.hasOwn(want, "$in")) return want.$in.some((w) => same(doc[key], w));
    if (want && typeof want === "object" && Object.hasOwn(want, "$exists")) return (doc[key] !== undefined) === Boolean(want.$exists);
    return same(doc[key], want);
  });
}

class FakeCollection {
  constructor({ unique = [], partial = {} } = {}) {
    this.docs = [];
    this.unique = unique;
    this.partial = partial; // fieldset -> predicate: the unique rule only covers docs it accepts
  }

  query(rows) {
    let out = rows;
    const q = {
      sort: (spec) => {
        const [[key, dir]] = Object.entries(spec);
        out = [...out].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir < 0 ? -1 : 1));
        return q;
      },
      limit: (n) => ((out = out.slice(0, n)), q),
      select: () => q,
      lean: () => q,
      then: (res, rej) => Promise.resolve(out.map((d) => ({ ...d }))).then(res, rej),
    };
    return q;
  }

  find(filter) { return this.query(this.docs.filter((d) => matches(d, filter))); }
  findOne(filter) {
    const found = this.docs.find((d) => matches(d, filter));
    const q = this.query(found ? [found] : []);
    return { lean: () => ({ then: (res, rej) => Promise.resolve(found ? { ...found } : null).then(res, rej) }), then: (res, rej) => Promise.resolve(found ? { ...found } : null).then(res, rej), select: () => q };
  }
  async countDocuments(filter) { return this.docs.filter((d) => matches(d, filter)).length; }

  checkUnique(doc, ignore) {
    for (const fields of this.unique) {
      const rule = this.partial[fields.join("+")];
      if (rule && !rule(doc)) continue;
      const clash = this.docs.some((d) => d !== ignore && (!rule || rule(d)) && fields.every((f) => same(d[f], doc[f])));
      if (clash) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
  }

  async create(doc) {
    const row = { _id: newId(), createdAt: new Date(), ...doc };
    this.checkUnique(row);
    this.docs.push(row);
    return { ...row };
  }

  async updateOne(filter, update, opts = {}) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) {
      if (opts.upsert) {
        const row = { _id: newId(), ...update.$setOnInsert };
        this.checkUnique(row);
        this.docs.push(row);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, upsertedCount: 0 };
    }
    const next = { ...doc, ...(update.$set || {}) };
    for (const k of Object.keys(update.$unset || {})) delete next[k];
    this.checkUnique(next, doc);
    Object.assign(doc, next);
    for (const k of Object.keys(update.$unset || {})) delete doc[k];
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  // Upsert only (what ensureDefaultList needs); returns a query with .lean().
  findOneAndUpdate(filter, update) {
    const run = async () => {
      const doc = this.docs.find((d) => matches(d, filter)) || (await this.create({ ...(update.$setOnInsert || {}) }));
      return { ...doc };
    };
    return { lean: run, then: (res, rej) => run().then(res, rej) };
  }

  async deleteMany(filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }

  async deleteOne(filter) {
    const i = this.docs.findIndex((d) => matches(d, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
}

module.exports = { FakeCollection, newId };
