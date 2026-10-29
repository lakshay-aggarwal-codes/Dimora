# Backup and recovery (P17-T05)

## The facts that shape this page

- **Atlas does not back up a Free cluster.** Atlas's own docs (read 2026-10-28, https://www.mongodb.com/docs/atlas/backup-restore-cluster/) say backups are not available for Free clusters and to use `mongodump` and `mongorestore`. An earlier version of `docs/DEPLOYMENT.md` said the opposite; it was wrong and has been corrected. So **you are the backup**.
- A Free cluster is **paused after 30 days without a connection** and has 0.5 GB of space (docs/DEPLOYMENT.md). A dump of the demo data is small.
- Render's free service has no persistent disk: dumps are made **on your computer**, not on the server.
- Photos live in Cloudinary, not in MongoDB. A database dump does not contain photos; the listing keeps their Cloudinary ids. Losing the database means losing which photo belongs to what, not the files themselves.

## What is in the database

| Matters most | Collections | If lost |
|---|---|---|
| Accounts and content | `users`, `listings`, `reviews`, `reservations`, `stay_nights` (the night ledger, ADR-004), `conversations`/`messages`, `reports`, `auditlogs`, `schema_migrations` | the site loses its history |
| Rebuildable | `sessions` (people log in again), `notifications`, `emailtokens` (links expire anyway), nearby-places cache (refreshed by `npm run refresh-nearby`) | no lasting harm |

## Routine

1. **Install the MongoDB Database Tools** on your computer (`mongodump`, `mongorestore`: https://www.mongodb.com/docs/database-tools/installation/installation-windows/).
2. **Take a dump** (before every release that has a migration, and weekly while people use the site). Keep the connection string out of your command history:

```powershell
Set-Location "C:\Users\Lakshay\Desktop\WebDev\project"
$env:MONGODB_URI = Read-Host "Atlas connection string (with /dimora)"
New-Item -ItemType Directory -Force -Path "$HOME\dimora-backups" | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
mongodump --uri="$env:MONGODB_URI" --gzip --archive="$HOME\dimora-backups\dimora-$stamp.archive.gz"
npm run data:snapshot -- --out "$HOME\dimora-backups\dimora-$stamp.snapshot.json"
Remove-Item Env:\MONGODB_URI
```

3. Keep the last few archives **outside the project folder and out of Git** (a dump contains email addresses and password hashes). A copy on a second device or a private cloud folder is what makes it a backup.
4. `npm run data:snapshot` writes only counts, index names and migration ids. It is the fingerprint you compare a restore against.

## Restoring

Restore into a **new, empty database first**, check it, and only then think about replacing the live one. A restore into the live database overwrites documents with the same `_id`.

```powershell
$env:MONGODB_URI = Read-Host "Connection string of the TARGET cluster (with /dimora-restore)"
mongorestore --uri="$env:MONGODB_URI" --gzip --archive="$HOME\dimora-backups\dimora-YYYY-MM-DD-HHMM.archive.gz" --nsInclude="dimora.*" --nsFrom="dimora.*" --nsTo="dimora-restore.*"
npm run data:snapshot -- --out "$HOME\dimora-backups\restored.snapshot.json"
npm run data:compare -- "$HOME\dimora-backups\dimora-YYYY-MM-DD-HHMM.snapshot.json" "$HOME\dimora-backups\restored.snapshot.json"
Remove-Item Env:\MONGODB_URI
```

`data:compare` must say the snapshots match: same collections, same document counts (sessions, notifications and email links are only noted, they change by themselves), no index missing, every migration still recorded. Then:

- Point a local copy of the app at the restored database (`MONGODB_URI` in `.env`), run `npm run migrate:dry` (nothing pending, nothing changed), `npm run dev`, log in as a known member, open a listing and a past reservation.
- To go live on the restored data, change `MONGODB_URI` in the Render dashboard to the restored database and redeploy; or restore over the live database after reading the warning above.
- After any restore the night ledger must still agree with the reservations: the sweeper's orphan scan reports disagreements in the log (`sweeper pass`); an empty report is the expected result.
- Free-cluster data older than the dump is gone. Say so to users.

If the cluster was **paused**: resume it in Atlas first (the data is kept). Atlas's page "Restore Data From Paused M0 Cluster" covers a cluster that was paused on a version it no longer supports.

## Rehearsal record

A procedure that was never run is a guess. Run the restore above once, on the demo data, and fill in this table.

| Date | Who | Dump size | Restore minutes | `data:compare` result | Problems found |
|---|---|---|---|---|---|
| _not yet rehearsed_ | | | | | |

**Status on 2026-10-28: not rehearsed.** The author had no database, no Atlas account and no network. The commands were written from the tools' documentation and the scripts' tests; the dump, restore and compare steps have not been executed together.

## Disaster cases

| Case | Do |
|---|---|
| A bad release changed data | Roll back the code (Render, docs/DEPLOYMENT.md), restore the pre-release dump into a new database, compare, switch `MONGODB_URI`. |
| Someone deleted content by mistake | Restore the latest dump into a new database; copy the documents back by hand; there is no per-document undo. |
| A secret leaked | Rotate it at its provider (Atlas user, Cloudinary, Mapbox, Resend), change the Render value and redeploy. Changing `SESSION_SECRET` logs everyone out and moves every public map pin (docs/DEPLOYMENT.md). |
| The Atlas cluster is gone | Create a new Free cluster, `mongorestore` the last archive, run `npm run migrate`, set `MONGODB_URI`. |
| Render service suspended or deleted | Re-create it from `render.yaml`; the data is in Atlas and Cloudinary, not on Render. |
