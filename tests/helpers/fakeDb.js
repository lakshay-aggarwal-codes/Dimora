// A tiny in-memory stand-in for the MongoDB driver's Db, just big enough for
// the migration runner's unit tests (no mongod needed). Supports equality
// filters, $set updates and the duplicate-key behaviour of a unique _id.
// Real-database behaviour is covered by tests/integration/migrate.db.test.js.
class FakeCollection {
  constructor(name) {
    this.collectionName = name;
    this.docs = [];
    this.writes = 0;
  }

  _match(doc, filter = {}) {
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
  }

  find(filter = {}) {
    const docs = this.docs
      .filter((doc) => this._match(doc, filter))
      .map((doc) => ({ ...doc }));
    return { toArray: async () => docs };
  }

  aggregate() {
    return { toArray: async () => [] };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => this._match(doc, filter)).length;
  }

  async insertOne(doc) {
    if (doc._id !== undefined && this.docs.some((d) => d._id === doc._id)) {
      const err = new Error(`E11000 duplicate key: ${doc._id}`);
      err.code = 11000;
      throw err;
    }
    this.writes += 1;
    this.docs.push({ ...doc });
    return { acknowledged: true };
  }

  async updateOne(filter, update) {
    const doc = this.docs.find((d) => this._match(d, filter));
    if (doc) {
      this.writes += 1;
      Object.assign(doc, update.$set);
    }
    return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
  }

  async deleteOne(filter) {
    const index = this.docs.findIndex((d) => this._match(d, filter));
    if (index >= 0) {
      this.writes += 1;
      this.docs.splice(index, 1);
    }
    return { deletedCount: index >= 0 ? 1 : 0 };
  }

  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !this._match(d, filter));
    if (this.docs.length !== before) this.writes += 1;
    return { deletedCount: before - this.docs.length };
  }
}

class FakeDb {
  constructor(databaseName = "fake_db") {
    this.databaseName = databaseName;
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection(name));
    }
    return this.collections.get(name);
  }

  /** Total number of write operations that changed data, across collections. */
  get writeCount() {
    let total = 0;
    for (const collection of this.collections.values()) {
      total += collection.writes;
    }
    return total;
  }
}

module.exports = { FakeDb, FakeCollection };
