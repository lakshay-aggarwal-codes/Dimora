// Notifications (P11-T01): create one for one member, count and list a
// member's own, mark them read.
//
//   notify(userId, type, ref, payload, options)  -> the stored row
//   countUnread(userId, options)                 -> number
//   listFor(userId, { show, page }, options)     -> { items, page, ... }
//   markRead(userId, id, options)                -> { changed }
//   markAllRead(userId, options)                 -> { updated }
//
// Rules, all enforced here and never by a form or a script:
// - `notify` writes exactly one row, for exactly the member it is given.
//   Who should be told about an event is decided by the caller (P11-T04);
//   this file never looks anyone up and never copies a row to someone else.
// - Every read and every update has `user` in its filter, so a member can
//   only count, list or mark their own rows. Someone else's id and a missing
//   id are the same 404.
// - Text is plain text (title <= 120, body <= 300 characters); the link must
//   be a same-site path. Anything else in `payload` is dropped. A bad value
//   throws a ValidationError and nothing is written.
// - Reading a row (once, or all) sets `readAt` and `deleteAfter`; the TTL index
//   deletes it READ_RETENTION_DAYS later. Marking again changes nothing.
//
// `options` lets tests pass `{ NotificationModel, now }`.
const {
  REF_KINDS,
  TYPE_PATTERN,
  LIMITS,
  READ_RETENTION_DAYS,
  PAGE_SIZE,
} = require("../config/notifications");
const { safeRedirectPath } = require("../utils/safeRedirect");
const { NotFoundError, ValidationError } = require("../utils/errors");
const { DEFAULT_TIMEZONE } = require("../utils/dates");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const model = (options) =>
  (options && options.NotificationModel) || require("../models/notification");
const clock = (options) => (options && options.now) || new Date();

/** The 24-character hex text of an id, an ObjectId or a user document; else null. */
function idText(value) {
  const raw = value && value._id !== undefined ? value._id : value;
  if (raw === null || raw === undefined || Array.isArray(raw)) return null;
  const text = typeof raw === "string" ? raw : String(raw);
  return OBJECT_ID.test(text) ? text.toLowerCase() : null;
}

function requireUser(userId) {
  const id = idText(userId);
  if (!id) throw new ValidationError("A notification needs a valid recipient.");
  return id;
}

/** A trimmed plain-text string within `max` characters, or a ValidationError. */
function text(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidationError(`A notification needs a ${name}.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`The notification ${name} must be text.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new ValidationError(`A notification needs a ${name}.`);
    return undefined;
  }
  if (CONTROL.test(trimmed)) {
    throw new ValidationError(`The notification ${name} has control characters.`);
  }
  if (trimmed.length > max) {
    throw new ValidationError(
      `The notification ${name} is longer than ${max} characters.`,
    );
  }
  return trimmed;
}

function cleanRef(ref) {
  if (ref === undefined || ref === null) return undefined;
  if (typeof ref !== "object" || Array.isArray(ref)) {
    throw new ValidationError("The notification reference is not valid.");
  }
  const id = idText(ref.id);
  if (!REF_KINDS.includes(ref.kind) || !id) {
    throw new ValidationError("The notification reference is not valid.");
  }
  return { kind: ref.kind, id };
}

/**
 * Stores one notification for one member.
 * @param {*} userId the recipient (id, ObjectId or user document)
 * @param {string} type e.g. "reservation.requested"
 * @param {{ kind: string, id: * }} [ref] what it is about
 * @param {{ title: string, body?: string, url?: string }} payload
 */
async function notify(userId, type, ref, payload, options) {
  const user = requireUser(userId);
  if (
    typeof type !== "string" ||
    type.length > LIMITS.type ||
    !TYPE_PATTERN.test(type)
  ) {
    throw new ValidationError("The notification type is not valid.");
  }
  const data = payload && typeof payload === "object" ? payload : {};
  const title = text(data.title, "title", LIMITS.title, { required: true });
  const body = text(data.body, "text", LIMITS.body);
  const url = text(data.url, "link", LIMITS.url);
  if (url !== undefined && safeRedirectPath(url, null) === null) {
    throw new ValidationError("The notification link must be a page on this site.");
  }
  const doc = { user, type, title };
  const cleaned = cleanRef(ref);
  if (cleaned) doc.ref = cleaned;
  if (body !== undefined) doc.body = body;
  if (url !== undefined) doc.url = url;
  return model(options).create(doc);
}

/** How many of the member's notifications are unread. */
async function countUnread(userId, options) {
  const user = requireUser(userId);
  return model(options).countDocuments({ user, readAt: null });
}

function parsePage(raw) {
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return n >= 1 ? n : 1;
}

const when = (date) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: DEFAULT_TIMEZONE,
  }).format(date);

function describe(row) {
  const created = row.createdAt instanceof Date ? row.createdAt : null;
  return {
    id: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body || "",
    // A stored link is trusted only if it still passes the same-site check.
    url: row.url ? safeRedirectPath(row.url, null) : null,
    read: Boolean(row.readAt),
    when: created ? when(created) : "",
    iso: created ? created.toISOString() : "",
  };
}

/**
 * One page of the member's own notifications, newest first.
 * @param {{ show?: string, page?: string }} query `show=unread` lists only unread
 */
async function listFor(userId, { show, page } = {}, options) {
  const user = requireUser(userId);
  const Notification = model(options);
  const unreadOnly = show === "unread";
  const filter = unreadOnly ? { user, readAt: null } : { user };
  const [total, unread] = await Promise.all([
    Notification.countDocuments(filter),
    unreadOnly
      ? Promise.resolve(null)
      : Notification.countDocuments({ user, readAt: null }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(parsePage(page), totalPages);
  const rows = await Notification.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
  return {
    items: rows.map(describe),
    show: unreadOnly ? "unread" : "all",
    page: current,
    totalPages,
    total,
    unread: unreadOnly ? total : unread,
    pageSize: PAGE_SIZE,
  };
}

const readUpdate = (now) => ({
  $set: {
    readAt: now,
    deleteAfter: new Date(now.getTime() + READ_RETENTION_DAYS * DAY_MS),
  },
});

/**
 * Marks one of the member's notifications read. Doing it again is fine.
 * @returns {{ changed: boolean }} false when it was already read
 * @throws {NotFoundError} not the member's, or no such notification
 */
async function markRead(userId, id, options) {
  const user = requireUser(userId);
  const target = idText(id);
  if (!target) throw new NotFoundError("That notification does not exist.");
  const Notification = model(options);
  const result = await Notification.updateOne(
    { _id: target, user, readAt: null },
    readUpdate(clock(options)),
  );
  if (result.modifiedCount > 0) return { changed: true };
  const mine = await Notification.exists({ _id: target, user });
  if (!mine) throw new NotFoundError("That notification does not exist.");
  return { changed: false };
}

/** Marks all of the member's unread notifications read. */
async function markAllRead(userId, options) {
  const user = requireUser(userId);
  const result = await model(options).updateMany(
    { user, readAt: null },
    readUpdate(clock(options)),
  );
  return { updated: result.modifiedCount || 0 };
}

module.exports = {
  notify,
  countUnread,
  listFor,
  markRead,
  markAllRead,
  describe,
};
