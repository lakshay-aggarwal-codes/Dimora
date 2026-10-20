// In-memory stand-in for the AvailabilityBlock model (availability unit
// tests, no mongod). Only what src/services/availability.js uses.
const same = (a, b) => String(a) === String(b);

class FakeAvailabilityBlock {
  constructor() {
    this.docs = [];
    this.createFailure = null; // set to an Error to make create() fail
  }

  async create(doc) {
    await Promise.resolve();
    if (this.createFailure) throw this.createFailure;
    this.docs.push({ ...doc });
    return doc;
  }

  find(filter) {
    const ids = (filter._id && filter._id.$in) || [];
    const docs = this.docs.filter(
      (doc) =>
        ids.some((id) => same(id, doc._id)) &&
        (filter.listing === undefined || same(filter.listing, doc.listing)),
    );
    return { lean: async () => docs.map((doc) => ({ ...doc })) };
  }

  async deleteMany(filter) {
    await Promise.resolve();
    const ids = (filter._id && filter._id.$in) || [];
    const before = this.docs.length;
    this.docs = this.docs.filter(
      (doc) =>
        !(
          ids.some((id) => same(id, doc._id)) &&
          (filter.listing === undefined || same(filter.listing, doc.listing))
        ),
    );
    return { deletedCount: before - this.docs.length };
  }
}

module.exports = { FakeAvailabilityBlock };
