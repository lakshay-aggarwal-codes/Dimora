# Deployment (P19-T03)

Dimora is a college project. This is how to put it online **for free**, what the free plans really give you, and what you must expect from them. Nothing here has been run against a live Render, Atlas or Cloudinary account by the author of this document (see "Not verified").

Terms below were read on **2026-10-28** from the providers' own pages (links at the end). They change: re-read them before you rely on any number. None of these plans is unlimited or promised to stay free.

## Decision (ADR-011)

| Part | Choice | Why |
|---|---|---|
| App | **Render**, free web service, Node runtime, Blueprint file `render.yaml` | Deploys from a Git repository; HTTP health checks; managed TLS and a `*.onrender.com` address; rollback to the two previous deploys; a Blueprint file keeps the setup in the repository. |
| Database | **MongoDB Atlas** Free cluster | The app is MongoDB-only; no code change. |
| Images | **Cloudinary** Free plan | Already used by the code. |
| Maps | Mapbox, as decided in ADR-007 | Not changed by this task. |

Not chosen: **Railway**. On 2026-10-28 its docs list a Free plan with $1 of credit a month and a one-time $5 trial credit; always-on use means the Hobby plan at $5 a month. Good fallback if the Render sleep is unacceptable. **Fly.io** was not compared in this task.

## What the free plans mean for Dimora

| Limit (source, 2026-10-28) | Effect on Dimora |
|---|---|
| Render free web service **spins down after 15 minutes without traffic** and takes **about one minute** to wake; Render shows a loading page meanwhile. | The first visitor after a quiet period waits. Do a wake-up before a demo (`npm run smoke:deploy`). A pinger every 14 minutes is not a supported fix and burns instance hours. |
| **750 free instance hours per workspace per month**, shared by every free web service in the workspace; a spun-down service uses none. A month has 720 to 744 hours. | One always-awake service fits; two do not. At the limit Render suspends the free services until next month. |
| Render may **restart a free service at any time**; the file system is **ephemeral**. | Dimora keeps nothing on disk (sessions are in MongoDB, photos in Cloudinary). Restarts only drop requests in flight. |
| Free web service: **no shell, no one-off jobs, no pre-deploy command**, one instance only. | Migrations run in the build command; `make-admin` runs from your own computer (below). |
| Render may suspend a free service that starts an **uncommonly high amount of traffic to the internet** (database calls count). | A demo is far below this; do not run imports or load tests against the live site. |
| Outbound **SMTP ports 25, 465 and 587 are blocked** on free services. | P02-T05 (email) therefore sends through Resend's HTTPS API, not SMTP (docs/EMAIL.md, ADR-012). |
| While spun down, Render answers `/robots.txt` itself with "disallow all". | Search engines will not index the site while it sleeps (P18-T05). |
| Atlas Free: **0.5 GB** of data including indexes, **100 operations a second**, 500 connections, **10 GB in and 10 GB out per rolling 7 days**, no `$where`/server-side JavaScript, `allowDiskUse` ignored (32 MB sort limit). | Plenty for the demo data and a class's worth of use. A big import can fill it. Queries that sort in memory must stay under 32 MB (not measured; P18-T02 reviewed the indexes). |
| Atlas pauses a Free cluster after **30 days with no connection**. | If the site is not opened for a month the database pauses; resume it in Atlas. Export a copy of your data if you stop using it. |
| Atlas Free: no network peering, no private endpoints; **Atlas backups (snapshots) are not available for Free clusters**; Atlas's docs say to use `mongodump` and `mongorestore` instead (corrected 2026-10-28, an earlier version of this page said otherwise). | **You are the backup.** Take a `mongodump` before every release with a migration and on a schedule you can keep (docs/RECOVERY.md). |
| Cloudinary Free: **25 credits a month** (1 credit = 1,000 transformations, or 1 GB of storage, or 1 GB of delivery bandwidth), transformations and bandwidth in a rolling 30-day window. | The app stores up to 10 photos a listing at 5 MB each; the demo fits. Every size/format variant is a transformation, so many visitors on many photos is what uses the credits. |

### Background jobs only run while the service is awake

The housekeeping job (`SWEEPER_*`) and the nearby-places retry run inside the web process:

- While the service sleeps, **nothing expires and nothing completes.** A booking request nobody answered stays `pending` in the database; it is already treated as free in search and availability once its hold has lapsed, and the sweeper does a pass **immediately on start-up** and then every minute, so it catches up on the next wake.
- Reviews need a `completed` stay, so a review can be a little late after a sleeping check-out.
- A host's answer deadline (24 hours) is enforced by the clock, not by the job, but the status text can lag until the next wake.

## First deployment

1. **Atlas.** Create a Free cluster (pick the region closest to Render's `singapore` region among the Free regions Atlas offers). Create a **database user of its own** with a long random password and rights on the one `dimora` database only. Under *Network Access* allow the app to connect: Render's outbound addresses are shared ranges that it publishes per region and can change; the simple choice is `0.0.0.0/0`, which leaves the password and TLS as the only protection, so keep the password long and never reuse it. Copy the `mongodb+srv://` string and put the database name before the `?` (`.../dimora?retryWrites=true&w=majority`). There is no Atlas backup on a Free cluster: set up the `mongodump` routine in docs/RECOVERY.md.
2. **Cloudinary.** Sign up for the Free plan; note cloud name, API key and API secret.
3. **Mapbox.** You need two tokens (ADR-007): a **secret** (`sk.`) server token and a **public** (`pk.`) token. Restrict the public token to your site's address in the Mapbox account once you know it (step 6).
4. **Git.** Push the repository to GitHub (the `.env` file is git-ignored; run `npm run preflight` first, below).
5. **Render.** *New > Blueprint*, choose the repository. Render reads `render.yaml` and asks for every value marked `sync: false`. `SESSION_SECRET` is generated for you.
6. **Set `APP_BASE_URL`** to the final address, `https://<service-name>.onrender.com` (no trailing slash). If the name you chose is taken, Render adds a suffix: read the real address on the service page, then set `APP_BASE_URL` and the Mapbox token restriction to it and redeploy.
7. **Deploy** (Blueprint services created with `autoDeploy: false` need a manual *Deploy latest commit*). The build runs `npm ci` and `npm run migrate`; when the new instance answers `/healthz` Render switches traffic to it.
8. **Smoke test** from your computer (wakes the service first):

```powershell
Set-Location "C:\Users\Lakshay\Desktop\WebDev\project"
npm run smoke:deploy -- https://YOUR-SERVICE.onrender.com
```

9. **Admin account.** Register normally on the live site, then promote that account **from your own computer**, because the free service has no shell. Put the production connection string in a *temporary* `.env` (never commit it) or set it for this one window only:

```powershell
$env:MONGODB_URI = "mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/dimora"
npm run make-admin -- you@example.com
Remove-Item Env:\MONGODB_URI
```

   `npm run seed` refuses to run when `NODE_ENV=production` by design; demo data for the live site comes with P19-T02.

### Settings (all in the Render dashboard; none is written in the repository)

| Key | Value |
|---|---|
| `NODE_ENV` | `production` (in `render.yaml`) |
| `NODE_VERSION` | `24.14.1` (in `render.yaml`; Render's default on 2026-10-28, pinned; the app needs Node 20.19 or newer) |
| `APP_BASE_URL` | your `https://` address |
| `MONGODB_URI` | the Atlas string with the `dimora` database name |
| `SESSION_SECRET` | generated by Render; **do not change it casually**: it also keys every listing's approximate public location (ADR/P06-T02), so a new secret moves every public map pin until migration 007 is re-run |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | from Cloudinary |
| `MAPBOX_SERVER_TOKEN`, `MAPBOX_PUBLIC_TOKEN` | two different tokens; the app refuses to start in production if they are equal or the public one is `sk.` |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `RESEND_API_KEY`, `EMAIL_VERIFICATION_REQUIRED` | `resend` + sender on a domain verified at Resend + API key + `true`; **or**, with no domain of your own, `console` + `false` (docs/EMAIL.md). With `console` and `true` nobody can publish or book. |
| `NEARBY_CONTACT` | an email or URL that identifies you to the Overpass operators |
| `TRUST_PROXY_HOPS` | `1` to start; check it ("Client address") |
| `NEARBY_ENABLED`, `SWEEPER_ENABLED`, `MAPBOX_GEOCODING_PERMANENT` | `true`, `true`, `false` (in `render.yaml`) |

Before you push, with the production values in `.env` (or in the shell): `npm run preflight`. It prints ok / warn / FAIL per item and never prints a secret.

## Health checks

- `GET /healthz`: the process answers. Never touches the database. **This is Render's check** (`healthCheckPath` in `render.yaml`). It is deliberately independent of Atlas: Render restarts an instance whose check fails, and restarting a healthy server because the database is slow or paused would not help.
- `GET /readyz`: 200 only while the MongoDB connection is open, otherwise 503. Use it for an uptime monitor or by hand.

Both are `GET`/`HEAD` only, return `{"status": ...}` and nothing about the build or settings, are not written to the request log, create no session and need no CSRF token.

## Client address (`TRUST_PROXY_HOPS`)

The login (5 failures per 15 minutes), signup, price-quote and report limits are counted **per client address**. Express finds that address by trusting a number of proxy hops in `X-Forwarded-For`. In production the app trusts `TRUST_PROXY_HOPS` hops (default **1**).

Render documents `1`, but community reports say its chain is longer (Cloudflare in front of its load balancers) and that it does not strip a client-supplied `X-Forwarded-For`. **This was not verified here.** Too low a number puts all visitors behind one address (a handful of failed logins locks everyone out); too high lets a visitor invent addresses and dodge every limit. After the first deploy, check:

```powershell
$url = "https://YOUR-SERVICE.onrender.com/api/listings/000000000000000000000000/quote?in=2030-01-01&out=2030-01-02&guests=1"
# Part 1: 65 requests from this computer, each pretending to be another address.
$codes = 1..65 | ForEach-Object {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{ "X-Forwarded-For" = "203.0.113.$_" }).StatusCode }
  catch { [int]$_.Exception.Response.StatusCode }
}
$codes | Group-Object | Select-Object Name, Count
```

- **429 appears (about the last five)**: the invented addresses were ignored. Good. Now open the same URL on a phone using mobile data **within the same minute**: if it also answers 429, the number is **too low**; raise `TRUST_PROXY_HOPS` by one, redeploy and repeat.
- **No 429 at all**: every invented address got its own allowance, so the number is **too high**; lower it and repeat.
- You want: 429 for the computer after 60 requests, and **no** 429 on the phone.

Record the value that worked in this file.

## Migrations on deploy

`buildCommand` is `npm ci && npm run migrate`. The runner (docs/MIGRATIONS.md) applies pending migrations in order, records them in `schema_migrations`, claims each one with a unique insert so two builds cannot both apply it, and stops on a changed or missing applied file.

- A migration that fails **fails the build**; Render keeps serving the previous version.
- The build and the old instance run **at the same time** during a deploy, and a rollback runs the old code on the new schema. So every migration must be **additive and backward compatible**: add fields and indexes first, switch the code, remove old fields in a later release (expand, then contract). `003-listing-model-v2` has a manual `down`; the others do not.
- Look before you leap: `npm run migrate:dry` from your computer with the production `MONGODB_URI` (as in step 9) prints what would run and writes nothing.
- The build needs the production environment (migration 007 reads `SESSION_SECRET`). Render makes the service's environment variables available to the build command; confirm it in the first build log (a migration that cannot find `MONGODB_URI` fails the build, which is the safe outcome).

## Updating and rolling back

1. `npm run lint`, `npm test`, `npm run preflight` on your computer; CI must be green.
2. If the release has a migration: take a `mongodump` and a data snapshot first (docs/RECOVERY.md), then run `npm run migrate:dry`.
3. Push, then *Deploy latest commit* in Render (`autoDeploy: false`). Switch to `autoDeploy: true` only once you trust steps 1 and 2.
4. `npm run smoke:deploy -- https://YOUR-SERVICE.onrender.com`.

**Rolling back code:** use the service's rollback in the Render dashboard (Render's "Rollbacks" page describes it). On the free plan that works **only to the two most recent previous deploys**. It does not undo a migration (see the additive rule above). If a bad deploy never answers `/healthz`, Render cancels it after 15 minutes and keeps the old instance.

**Rolling back data:** restore from the `mongodump` you took before the release (docs/RECOVERY.md; Atlas has no snapshot to offer on a Free cluster). Data written since the dump is lost; say so to users. A paused or restored cluster keeps the same connection string unless you create a new one.

**Rolling back a bad secret:** change the value in the Render dashboard and redeploy; rotate Cloudinary, Mapbox and Atlas credentials at the provider first if one leaked.

## Not verified

- No deployment was run from the sandbox this was written in (no network, no accounts). `render.yaml` was checked by tests for shape and for secrets, **not** by Render's validator (`render blueprints validate render.yaml` with the Render CLI will do that).
- `TRUST_PROXY_HOPS=1` is a starting value, not a verified one (above).
- Whether the Render free plan asks for a payment card at sign-up, the exact size of Render's free build allowance, and the Render outbound address ranges were not checked.
- `/healthz` timing on a cold start was not measured; Render says "about one minute".

## Sources (read 2026-10-28)

- Render, Deploy for Free: https://render.com/docs/free
- Render, Health Checks: https://render.com/docs/health-checks
- Render, Blueprint spec (`preDeployCommand`, `generateValue`, `healthCheckPath`): https://render.com/docs/blueprint-spec
- Render, Node.js version: https://render.com/docs/node-version
- MongoDB Atlas, Free cluster limits: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
- Cloudinary, plans and credits: https://cloudinary.com/documentation/billing_and_plans
- Railway, plans: https://docs.railway.com/pricing/plans
