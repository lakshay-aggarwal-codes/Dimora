# Restore after the lost updates

Date: 2026-10-30.

Older copies of files, taken by other chats, undid work of earlier tasks. Using the Git history, each commit's change was worked out against the snapshot it was built on and re-applied on top of the current files, in order. Only additions and modifications were applied, never plain deletions; the earlier fixes (merge fix, fix1 to fix3) were kept.

Restored (examples): the conversations, notifications and account routers and the message rate limit in `src/app.js`; the accessibility field in the listing model and the wizard; trips: change dates (task 88) in `src/controllers/trips.js`, `src/services/trips.js`, `views/trips/show.ejs`; dynamic price rules in the pricing step; the notifications bell in the navbar; the sections-based edit page test; `reminders.checkIn` on reservations; `npm run test:e2e`; the corrected DEPLOYMENT notes.

Four older tests were changed to match the input guard (task 75): operator-shaped values such as `page[$gt]=1` are now refused with 400 instead of ignored.

Not restored: task 97 (simulated payment). Its source files (`src/models/paymentAttempt.js`, `src/services/payments.js`, `src/controllers/payments.js`, `views/payments/pay.ejs`) never reached the repository; only its tests and notes did. Run task 97 again.
