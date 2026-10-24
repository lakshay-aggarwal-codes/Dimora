// Notification settings (P11-T01). Plain constants, no environment reads.

// What a notification may point at. P11-T02 and P11-T04 add their kinds here
// (the model and the service both read this list).
const REF_KINDS = Object.freeze([
  "reservation",
  "listing",
  "review",
  "conversation",
  "report",
]);

// Stable machine name of an event, e.g. "reservation.requested". Same shape as
// the audit log's action names.
const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const LIMITS = Object.freeze({
  type: 60,
  title: 120,
  body: 300,
  url: 300,
});

// A read notification is deleted this long after it was read (MongoDB TTL
// index on `deleteAfter`). An unread one is kept until it is read.
const READ_RETENTION_DAYS = 30;

const PAGE_SIZE = 20;

// The bell asks for the unread count this often while the tab is visible.
const POLL_SECONDS = 30;

module.exports = {
  REF_KINDS,
  TYPE_PATTERN,
  LIMITS,
  READ_RETENTION_DAYS,
  PAGE_SIZE,
  POLL_SECONDS,
};
