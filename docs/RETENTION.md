# Data retention (P17-T05)

What Dimora keeps, for how long, and what removes it. Written from the code on 2026-10-28; where the answer depends on a provider it says so. This is a student project's statement, not legal advice. The user-facing version is the Privacy page.

| Data | Where | Kept | Removed by |
|---|---|---|---|
| Account (username, email, display name, bio, avatar, password hash) | MongoDB `users` | until the member deletes the account | Account deletion **anonymises**: username `deleted-<id>`, name "Deleted user", email replaced, bio and avatar removed, password made unusable (`src/services/account.js`). The row stays so that others' bookings and reviews still point at something. |
| Sessions | MongoDB `sessions`, cookie | 7 days | expiry (cookie `maxAge` and the store's lifetime); log out |
| One-time email links | `emailtokens` (hash only) | link valid 24 h (confirm) / 1 h (reset); row removed 7 days after expiry | TTL index; a newer link cancels the older one |
| Failed-login counter | on the user | until a good login or a password reset | login, reset |
| Listings | `listings`, photos at Cloudinary | until the host deletes them; delete is a **soft delete** (`deletedAt`), the document stays hidden | never removed automatically. Drafts not touched for **90 days** are deleted, with their photos, by the housekeeping job (only runs while the service is awake) |
| Reservations, night ledger | `reservations`, `stay_nights` | kept | never deleted by the app (they are the record of what happened) |
| Reviews | `reviews` | kept, also after the author's account is anonymised | never deleted by the app; admin moderation can hide |
| Messages, reports, audit log | `conversations`, `reports`, `auditlogs` | kept | never deleted by the app |
| Saved stays, notifications | `wishlists`, `notifications` | saved stays until removed or the account is deleted; a read notification is deleted **30 days after it was read** | TTL index; account deletion removes both |
| Server logs | Render's log stream (stdout) | **not set by Dimora**: Render's retention applies and was not checked | Logs hold a request id, method, path and status. Not logged: query strings, form fields, cookies, headers, passwords, one-time email links (their path part is replaced by `[redacted]`). Proven by `tests/unit/logger.redaction.test.js` and `tests/integration/requestLog.db.test.js` |
| Backups | on the owner's computer (docs/RECOVERY.md) | until the owner deletes them | the owner. A dump contains email addresses and password hashes, so deleting an account does **not** delete it from older dumps |
| Email | Resend, if configured | Resend's own retention applies (not checked) | the provider |
| Maps, geocoding, photos | Mapbox, Cloudinary | provider terms apply | provider |

## Rules the code follows

1. No data is collected for advertising or analytics (the Privacy page says so).
2. Nothing secret is logged (list in `src/config/logger.js`; test above).
3. A new kind of stored data needs a row in this table and a sentence on the Privacy page in the same change.

## Gaps, said plainly

- Deleting an account does not remove reviews, bookings, messages or reports it took part in; it removes what identifies the person. Reports and audit rows are kept as records.
- Soft-deleted listings and their photos are kept indefinitely; there is no purge job.
- Backups outlive deletions (above).
- No automatic expiry for old reservations, reviews or messages.
