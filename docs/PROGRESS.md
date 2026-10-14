# Progress

Queue order and IDs: see `DIMORA_TASK_RUNNER.md` §7. Specification: `MASTER_ROADMAP.md`.

| Q | ID | Status | Date | Summary | Limitations |
|---|---|---|---|---|---|
| 1 | P00-T01 | done | 2026-10-14 | `npm ci` works without flags: removed `multer-storage-cloudinary`, uploads now use `multer.memoryStorage()` + `cloudinary.uploader.upload_stream`; added `engines` (Node >=20.19.0); lockfile regenerated | Live Cloudinary upload and `npm run dev` smoke not executed in sandbox (no credentials/DB) |
| 2 | P00-T02 | partial | 2026-10-14 | Verdict for every D-ID in `docs/BASELINE.md`; D-02/03/06/08–14 reproduced against the real app with stubbed DB/auth/Cloudinary; D-16 resolved from package source | Owner live checks pending (checklist in `docs/tasks/P00-T02.md`); no real Atlas/Cloudinary/Mapbox, no browser |
