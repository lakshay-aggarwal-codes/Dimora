// Audit service (P14-T01). Every administrative action writes exactly one row
// through record(), in the same request as the action (see
// src/middleware/admin.js `auditedMutation`, which enforces that). The viewer
// reads through listAudit(); nothing here updates or deletes a row.
const AuditLog = require("../models/auditLog");
const User = require("../models/user");
const { tryParseDateOnly, formatDateOnly, addDays } = require("../utils/dates");

const { TARGET_TYPES } = AuditLog;

const PAGE_SIZE = 25;

// Details are small facts about a change (old/new status...). Anything that
// looks like a credential is refused so a careless caller cannot leak one into
// a log that admins read.
const SECRET_KEY = /pass(word)?|token|secret|hash|salt|cookie|authorization/i;

function assertSafeDetails(details, path = "details") {
  if (details === undefined || details === null) return;
  if (Array.isArray(details)) {
    details.forEach((item, i) => assertSafeDetails(item, `${path}[${i}]`));
    return;
  }
  if (typeof details === "object") {
    for (const [key, value] of Object.entries(details)) {
      if (SECRET_KEY.test(key)) {
        throw new Error(`audit.record: ${path}.${key} must not be logged`);
      }
      assertSafeDetails(value, `${path}.${key}`);
    }
  }
}

/**
 * Writes one audit row and counts it on the request (`req.auditRecorded`), so
 * the auditedMutation wrapper can check it.
 *
 * @param {object} entry
 * @param {object} [entry.actor] the admin user (default: req.user)
 * @param {string} [entry.actorLabel] who acted when there is no logged-in admin
 * @param {string} entry.action e.g. "user.suspend" (lower-case, dot separated)
 * @param {string} entry.targetType user | listing | review | report | reservation | system
 * @param {*} [entry.targetId]
 * @param {string} [entry.reason]
 * @param {object} [entry.details]
 * @param {object} [entry.req] the Express request (request id, default actor)
 * @param {object} [options] { session } for a MongoDB transaction
 */
async function record(entry, options = {}) {
  const { req, reason, details } = entry;
  const actor = entry.actor || (req && req.user) || null;
  const actorLabel = entry.actorLabel;
  if (!actor && !actorLabel) {
    throw new Error("audit.record: an actor or an actorLabel is required");
  }
  assertSafeDetails(details);

  const doc = {
    actor: actor ? actor._id || actor : null,
    actorLabel: actorLabel || undefined,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    reason: typeof reason === "string" && reason.trim() ? reason : undefined,
    details: details ?? undefined,
    requestId: req && req.id ? String(req.id) : undefined,
  };

  const [row] = await AuditLog.create([doc], options.session ? { session: options.session } : {});
  if (req) req.auditRecorded = (req.auditRecorded || 0) + 1;
  return row;
}

/** A positive whole page number, else 1 (never throws, never reaches the query). */
function toPageNumber(value) {
  if (typeof value !== "string" || !/^[0-9]{1,6}$/.test(value)) return 1;
  const n = Number(value);
  return n >= 1 ? n : 1;
}

const FILTER_MAX = 80;
const ACTION_PREFIX = /^[a-z][a-z0-9_.]*$/;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The log's filters, cleaned. Text is matched as plain text; a date that is not
 * a real YYYY-MM-DD is ignored. `to` is inclusive (the whole day, UTC).
 */
function cleanFilters({ action, actor, targetType, from, to } = {}) {
  const str = (v) => (typeof v === "string" ? v.trim().slice(0, FILTER_MAX) : "");
  const fromDate = tryParseDateOnly(str(from));
  const toDate = tryParseDateOnly(str(to));
  const act = str(action).toLowerCase();
  return {
    action: ACTION_PREFIX.test(act) ? act : "",
    actor: str(actor),
    targetType: TARGET_TYPES.includes(str(targetType)) ? str(targetType) : "",
    from: fromDate ? formatDateOnly(fromDate) : "",
    to: toDate ? formatDateOnly(toDate) : "",
    fromDate,
    toDate,
  };
}

/**
 * One page of the log, newest first, for the read-only viewer, optionally
 * filtered by action (exact name or a prefix such as "user."), actor username,
 * target type and a UTC date range.
 * @returns {{rows: object[], page: number, totalPages: number, total: number, pageSize: number, filters: object}}
 */
async function listAudit({ page, ...rawFilters } = {}) {
  const f = cleanFilters(rawFilters);
  const filter = {};
  if (f.action) filter.action = new RegExp(`^${escapeRegex(f.action)}`);
  if (f.targetType) filter.targetType = f.targetType;
  if (f.actor) {
    const rx = new RegExp(`^${escapeRegex(f.actor)}$`, "i");
    const users = await User.find({ username: rx }).select("_id").limit(5).lean();
    // Rows written outside a login are labelled instead (see audit.record).
    filter.$or = [{ actor: { $in: users.map((u) => u._id) } }, { actorLabel: rx }];
  }
  if (f.fromDate || f.toDate) {
    filter.createdAt = {};
    if (f.fromDate) filter.createdAt.$gte = f.fromDate;
    if (f.toDate) filter.createdAt.$lt = addDays(f.toDate, 1);
  }

  const total = await AuditLog.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(toPageNumber(page), totalPages);
  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .populate("actor", "username displayName")
    .lean();
  const { fromDate, toDate, ...shown } = f;
  return { rows, page: current, totalPages, total, pageSize: PAGE_SIZE, filters: shown };
}

module.exports = { record, listAudit, cleanFilters, toPageNumber, PAGE_SIZE };
