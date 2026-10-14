# Database migrations

```powershell
npm run migrate:dry     # preview: runs each pending up() against a read-only db, writes nothing
npm run migrate         # apply every pending migration, in order
```

`npm run migrate -- --dry-run` is the same as `migrate:dry`. Without the `--`, npm treats `--dry-run` as its own flag and the runner never sees it.

The runner reads `MONGODB_URI` (or the old `ATLASDB_URL`) from the environment / `.env`. It prints the database name, never the connection string. It is allowed in production (that is where migrations are needed); run `migrate:dry` first.

## How it works

- Files: `scripts/migrations/NNN-short-name.js` (three or more digits, lowercase letters, digits and hyphens). Any other `.js` file in that folder stops the run.
- Each file exports `async up(db, ctx)`:
  - `db` is the native MongoDB `Db` (`db.collection("users").updateMany(...)`), not a Mongoose model. Do not `require` models: a migration must keep working after the models change.
  - `ctx.dryRun` is `true` in a dry run, `ctx.log(message)` prints a line.
  - Return an object of counts, e.g. `{ scanned: 120, modified: 118 }`. It is printed and stored.
- Applied migrations are recorded in the `schema_migrations` collection: `_id` (the file name without `.js`), `checksum` (SHA-256 of the file, line endings ignored), `status`, `startedAt`, `appliedAt`, `durationMs`, `result`.
- The record is inserted (`status: "running"`) **before** `up` runs. `_id` is unique, so two runs cannot both apply a migration. After `up` succeeds the record becomes `applied`.

## Rules

1. **Never edit or delete an applied migration.** A changed checksum or a missing file stops every run. Put the change in a new migration.
2. **Number new migrations above every applied one.** A pending migration numbered below an applied one stops the run.
3. **Make `up` safe to repeat** (filters like `{ field: { $exists: false } }`, `createIndex` is already idempotent). If it fails half-way it is not recorded and runs again next time.
4. **In a dry run, do not write.** The runner hands `up` a read-only `db`; a write throws "Dry run: the migration tried to write". Branch on `ctx.dryRun` and only count what would change. The guard blocks the driver's write methods and `$out`/`$merge`, but it is a safety net: reaching the real database through `db.client` bypasses it.
5. Prefer small migrations (one concern each) and log counts, so a run can be read afterwards.

## When something stops the run

| Message | Meaning | Fix |
|---|---|---|
| `was changed after it was applied` | file edited after it ran | revert the edit; add a new migration |
| `was applied but its file is missing` | file deleted/renamed | restore it |
| `is numbered below the latest applied migration` | out-of-order new file | renumber it above the latest |
| `is marked as running` | another run is active, or a run was interrupted | if no run is active, check whether its changes were applied, then `db.schema_migrations.deleteOne({ _id: "<id>" })` |
| `<id> failed and was not recorded` | `up` threw | fix the cause, run again |

## Template

```js
// scripts/migrations/002-example.js
module.exports = {
  async up(db, ctx) {
    const filter = { somethingNew: { $exists: false } };
    const todo = await db.collection("listings").countDocuments(filter);
    if (ctx.dryRun) return { wouldUpdate: todo };
    const { modifiedCount } = await db
      .collection("listings")
      .updateMany(filter, { $set: { somethingNew: null } });
    return { scanned: todo, modified: modifiedCount };
  },
};
```
