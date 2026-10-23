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

## Shipped migrations

| File | What it does |
|---|---|
| `001-baseline.js` | No-op starting point. |
| `002-user-model-v2.js` | Users: lower-cases/trims `email`, adds `displayName`, `role`, `status`, `bio`, `emailVerifiedAt`, `createdAt`, `updatedAt`, builds the unique index `email_1`. Does not delete users or touch `hash`/`salt`/`username`. |
| `003-listing-model-v2.js` | Listings: `status` "published" for every existing listing, `pricing.nightlyMinor` = old rupee `price` x 100 (old value kept in `legacyPrice`, `price` removed), `address.city/country` guessed from `location/country`, `images[]` from the old `image`, defaults for the new fields, rating aggregates from the existing reviews, `createdAt/updatedAt`, `needsReview`, and four indexes. Never deletes a listing. |
| `004-listing-images-v2.js` | Listing photos: in every `images[]` entry `filename` is renamed `publicId`, an `_id` is added (photo routes identify a photo by it), `alt` is added, `order` is set to the array position. Skips photos already upgraded; deletes nothing except the renamed `filename` key. Manual `down` puts `filename` back. |
| `005-listing-wizard.js` | Listings: builds the unique partial index `owner_1_draftToken_1`, so the first wizard step submitted twice makes one draft. No data changes. Manual `down` drops it. |
| `008-review-model-v2.js` | Reviews (ADR-010): `legacy: true` on every review without a reservation, `listing` filled from the listing that holds it, `createdAt`/`updatedAt` from the `_id` where missing, the misspelt `crestedAt` removed, indexes `reservation_1_unique` (partial, unique), `listing_1_createdAt_-1`, `author_1_createdAt_-1`. Deletes nothing. A review no listing holds keeps no `listing`. Run `migrate:dry` first: it prints the counts. |

### 002 and duplicate emails

Two accounts that share an address (ignoring case and spaces) make the unique index impossible. The migration then **changes nothing** and stops with a list of user ids and usernames (no emails are printed). `npm run migrate:dry` prints the same list without failing. To fix, change one address per group, then run the migration again:

```powershell
# mongosh "<your MONGODB_URI>"
db.users.updateOne({ _id: ObjectId("<id from the report>") }, { $set: { email: "new-address@example.com" } })
```

Run `migrate:dry` and `migrate` **before** starting a version of the app that has the v2 user model: the model asks MongoDB for the same unique index at startup, and that fails while duplicates exist.


### 003: before and after

Run `migrate:dry` and `migrate` **before** starting the version of the app with the v2 listing model. Until it has run, old listings still load but show "Price not set", because the model no longer reads the old `price` field.

A listing is flagged `needsReview: true` when its address was guessed, its price is missing or under INR 100, or it has no coordinates. The dry run prints the counts (`withoutPrice`, `belowFloor`, `withoutGeometry`, `flaggedForReview`). A listing with no usable price gets **no** price (it is not invented); set it by editing the listing.

Rollback is manual, because the runner only calls `up`. To put the old `price` field back and drop the four indexes, from the repo root in PowerShell:

```powershell
node -e "require('dotenv').config(); const {MongoClient}=require('mongodb'); (async()=>{const c=await MongoClient.connect(process.env.MONGODB_URI); const db=c.db(); console.log(await require('./scripts/migrations/003-listing-model-v2').down(db,{})); await c.close()})()"
```

Then remove its record so it can run again later: `db.schema_migrations.deleteOne({ _id: "003-listing-model-v2" })`. The new fields stay in the documents (old code ignores them) and `status` is not undone.
