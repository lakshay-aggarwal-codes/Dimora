// Baseline migration (P01-T11): intentionally does nothing.
//
// It marks the schema as it was when the migration runner was introduced, so
// the first real migration (002-...) starts from a recorded point and the
// runner has something to apply on a fresh database.
//
// Authoring rules for new migrations: see docs/MIGRATIONS.md.
module.exports = {
  async up() {
    return {};
  },
};
