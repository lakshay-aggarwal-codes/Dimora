// A tiny in-memory stand-in for a Mongoose model (P11-T02 tests): enough of
// find/findOne/findById/create/updateOne/countDocuments for the messaging
// service, including $or/$and/$in/$ne/$lt/$gt, dotted paths, $inc/$set, sort,
// skip, limit, and a unique key that throws the driver's duplicate-key error.
const isId = (v) => v && typeof v === "object" && typeof v.toHexString === "function";
const same = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  return String(a) === String(b);
};
const getPath = (row, path) =>
  path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), row);
function setPath(row, path, value) {
  const keys = path.split(".");
  let o = row;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}
const isPlain = (v) =>
  v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const copy = (v) =>
  Array.isArray(v) ? v.map(copy) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v;

function matches(row, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(row, f));
    if (key === "$and") return cond.every((f) => matches(row, f));
    const value = getPath(row, key);
    if (isPlain(cond)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === "$in") return x.some((y) => same(value, y));
        if (op === "$ne") return !same(value, x);
        if (op === "$lt") return value !== undefined && String(value) < String(x);
        if (op === "$gt") return Number(value) > x;
        throw new Error(`fakeCollection: unsupported operator ${op}`);
      });
    }
    return same(value, isId(cond) ? String(cond) : cond);
  });
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fakeCollection({ uniqueKey, defaults = () => ({}), start = new Date("2026-10-01T10:00:00Z") } = {}) {
  const rows = [];
  const filters = [];
  let seq = 0;
  const hex = (n) => n.toString(16).padStart(24, "0");
  const found = (filter) => {
    filters.push(filter);
    return rows.filter((r) => matches(r, filter));
  };
  const query = (list) => {
    let result = list;
    const q = {
      select: () => q,
      sort: (spec) => {
        const entries = Object.entries(spec);
        result = result.slice().sort((a, b) => {
          for (const [k, dir] of entries) {
            const c = compare(getPath(a, k), getPath(b, k));
            if (c !== 0) return c * dir;
          }
          return 0;
        });
        return q;
      },
      skip: (n) => ((result = result.slice(n)), q),
      limit: (n) => ((result = result.slice(0, n)), q),
      lean: async () => result.map(copy),
    };
    return q;
  };
  // findOne / findById: select() and lean() give one row or null.
  const single = (list) => {
    const q = { select: () => q, lean: async () => (list[0] ? copy(list[0]) : null) };
    return q;
  };
  const model = {
    rows,
    // Puts rows with chosen _ids in place (users, listings, bookings).
    seed(...docs) {
      docs.forEach((d) => rows.push(copy(d)));
      return model;
    },
    filters,
    find: (filter) => query(found(filter)),
    findOne: (filter) => single(found(filter)),
    findById: (id) => single(found({ _id: id })),
    async create(doc) {
      if (uniqueKey && rows.some((r) => same(r[uniqueKey], doc[uniqueKey]))) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      }
      seq += 1;
      const row = copy({
        ...defaults(),
        ...doc,
        _id: hex(seq),
        createdAt: new Date(start.getTime() + seq * 1000),
      });
      rows.push(row);
      return copy(row);
    },
    async countDocuments(filter) {
      return found(filter).length;
    },
    async updateOne(filter, update) {
      const row = found(filter)[0];
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      for (const [k, v] of Object.entries(update.$inc || {})) setPath(row, k, (getPath(row, k) || 0) + v);
      for (const [k, v] of Object.entries(update.$set || {})) setPath(row, k, v);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return model;
}

module.exports = { fakeCollection, matches };
