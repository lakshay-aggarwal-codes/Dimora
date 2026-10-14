# Progress

Queue order and IDs: see `DIMORA_TASK_RUNNER.md` §7. Specification: `MASTER_ROADMAP.md`.

| Q | ID | Status | Date | Summary | Limitations |
|---|---|---|---|---|---|
| 1 | P00-T01 | done | 2026-10-14 | `npm ci` works without flags: removed `multer-storage-cloudinary`, uploads now use `multer.memoryStorage()` + `cloudinary.uploader.upload_stream`; added `engines` (Node >=20.19.0); lockfile regenerated | Live Cloudinary upload and `npm run dev` smoke not executed in sandbox (no credentials/DB) |
| 2 | P00-T02 | partial | 2026-10-14 | Verdict for every D-ID in `docs/BASELINE.md`; D-02/03/06/08–14 reproduced against the real app with stubbed DB/auth/Cloudinary; D-16 resolved from package source | Owner live checks pending (checklist in `docs/tasks/P00-T02.md`); no real Atlas/Cloudinary/Mapbox, no browser |
| 3 | P00-T03 | done | 2026-10-14 | Nine ADRs (001–009) and an index in `docs/ADR/` | 006 and 007 provisional until P01-T10 / P06-T01; 008 market default unconfirmed by owner |
| 4 | P01-T01 | done | 2026-10-14 | `src/config/env.js` Joi-validated config with fail-fast startup; hard-coded session secret removed; `dns.setServers` gated by `DNS_SERVERS`; `.env.example` rewritten | Real-credential run not executed; legacy env names accepted with warnings; owner must set a new `SESSION_SECRET` |
| 5 | P01-T02 | partial | 2026-10-14 | `package.json` renamed to `dimora`, `main`=`app.js`, scripts `start/dev/lint/lint:fix/format/format:check/test/seed/migrate`; ESLint 9 flat config + Prettier config + `nodemon.json`; `scripts/migrate.js` placeholder; unused imports removed from 3 route files, unused `message` removed in `app.js` error handler | Sandbox had no npm registry access: ESLint/Prettier never ran and `package-lock.json` was NOT regenerated; owner must run `npm install` once, then `npm run lint`, and commit the lockfile |
