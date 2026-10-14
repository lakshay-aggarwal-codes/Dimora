# Progress

Queue order and IDs: see `DIMORA_TASK_RUNNER.md` §7. Specification: `MASTER_ROADMAP.md`.

| Q | ID | Status | Date | Summary | Limitations |
|---|---|---|---|---|---|
| 1 | P00-T01 | done | 2026-10-14 | `npm ci` works without flags: removed `multer-storage-cloudinary`, uploads now use `multer.memoryStorage()` + `cloudinary.uploader.upload_stream`; added `engines` (Node >=20.19.0); lockfile regenerated | Live Cloudinary upload and `npm run dev` smoke not executed in sandbox (no credentials/DB) |
