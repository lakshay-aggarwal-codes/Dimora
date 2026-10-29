# ADR-011: Hosting: Render free web service, Atlas Free, Cloudinary Free

**Status:** Accepted (provisional until the first real deployment; revisit in P19-T04)

## Context

Dimora is a college project with no budget. It needs a Node host, a MongoDB database and an image store, all free, and it must be honest about what free means. Limits were read on 2026-10-28 and are listed with sources in `docs/DEPLOYMENT.md`.

## Decision

- **App:** Render free web service from the repository's `render.yaml`. It sleeps after 15 minutes of no traffic (about one minute to wake), has 750 free instance hours a month per workspace, an ephemeral file system, no shell and no pre-deploy command.
- **Database:** MongoDB Atlas Free (0.5 GB, 100 operations a second, paused after 30 days without a connection, **no Atlas backups on Free clusters**: `mongodump`/`mongorestore` by hand, docs/RECOVERY.md).
- **Images:** Cloudinary Free (25 credits a month).
- **Migrations** run in the build command (`npm ci && npm run migrate`), because the pre-deploy command is paid-only. Every migration is therefore additive and backward compatible.
- **Health:** `/healthz` (liveness, no database) is the host's check; `/readyz` (database connected) is for monitors.
- **Proxy hops** are a setting (`TRUST_PROXY_HOPS`), because the number in front of the app on Render is not documented by the provider.

## Consequences

- The first visitor after a quiet spell waits about a minute; background jobs (sweeper, nearby retry) only run while the service is awake and catch up when it wakes.
- Nothing may be stored on local disk.
- A rollback never reverses a migration.
- Backups are the owner's job (`mongodump`); Atlas does not take snapshots of a Free cluster.
- None of the free plans is promised to stay free; the deployment document is dated and must be re-read before relying on it.

## Rejected

- **Railway:** free plan is $1 of credit a month and a one-time $5 trial; always-on use is the $5 Hobby plan. Kept as the fallback if sleeping is unacceptable.
- **Fly.io:** not compared.
- **Keep-alive pinging** to avoid the sleep: not a supported fix and uses the instance hours.
