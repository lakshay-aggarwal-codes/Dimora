// Trust indicators (P12-T05): only facts the system actually knows, each with
// the meaning it really has. Shown on the public profile and in the host card
// of a listing.
//
//   emailConfirmed  the member opened a link sent to their address (P02-T05).
//                   It does NOT mean their identity was checked.
//   memberSince     month and year the account was created
//   staysHosted     reservations at their places that reached "completed"
//   response        of the booking REQUESTS (not instant bookings) of the last
//                   12 months that were decided, the share the host answered
//                   (accepted or declined) rather than let expire. Shown only
//                   with at least MIN_DECIDED decided requests; below that the
//                   page says nothing about it, never a percentage of 1 or 2.
//
// Deliberately absent: "verified host", "superhost", "trusted", star badges, a
// score. Dimora does no independent check of anybody, so none of those would be
// true. docs/TRUST.md lists the copy and the rules for adding an indicator.
const mongoose = require("mongoose");

const MIN_DECIDED = 5;
const WINDOW_DAYS = 365;
const MAX_SCANNED = 500;

const monthYear = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Kolkata", // ADR-008
});
const formatMonthYear = (date) =>
  date instanceof Date && !Number.isNaN(date.getTime()) ? monthYear.format(date) : "";

/**
 * Counts, from the status history of booking requests, how many the host
 * answered and how many expired unanswered. A request that the guest withdrew,
 * or that is still waiting, is in neither. A booking that was never a request
 * (instant book: it starts as confirmed) has no "from pending" step.
 * @param {Array<{ statusHistory?: Array<{from?: string|null, to?: string, actor?: string}> }>} reservations
 */
function summariseRequests(reservations) {
  let answered = 0;
  let expired = 0;
  for (const reservation of reservations || []) {
    const step = ((reservation && reservation.statusHistory) || []).find((h) => h && h.from === "pending");
    if (!step) continue;
    if ((step.to === "confirmed" || step.to === "declined") && step.actor === "host") answered += 1;
    else if (step.to === "expired") expired += 1;
  }
  return { answered, expired };
}

/** { percent, basedOn } or null when there are too few decided requests to say anything. */
function responseFrom({ answered, expired }) {
  const decided = answered + expired;
  if (decided < MIN_DECIDED) return null;
  return { percent: Math.round((100 * answered) / decided), basedOn: decided };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {{ emailConfirmed: boolean, memberSince: string, stats?: { staysHosted: number, answered: number, expired: number } | null }} input
 * @returns {{ items: {key: string, text: string}[], emailConfirmed: boolean, memberSince: string, staysHosted: number, response: object|null }}
 */
function buildTrust({ emailConfirmed, memberSince, stats = null }) {
  const staysHosted = stats && Number.isSafeInteger(stats.staysHosted) ? stats.staysHosted : 0;
  const response = stats ? responseFrom(stats) : null;
  const items = [];
  if (emailConfirmed) items.push({ key: "email", text: "Email address confirmed" });
  if (memberSince) items.push({ key: "since", text: `Member since ${memberSince}` });
  if (staysHosted > 0) items.push({ key: "stays", text: `${plural(staysHosted, "stay", "stays")} hosted` });
  if (response) {
    items.push({
      key: "response",
      text: `Answered ${response.percent}% of booking requests in the last 12 months (${plural(response.basedOn, "request", "requests")})`,
    });
  }
  return { items, emailConfirmed: Boolean(emailConfirmed), memberSince, staysHosted, response };
}

/**
 * Reads what the indicators need. `member` is a user document (or lean object)
 * that already has createdAt / emailVerifiedAt, or an id (the user is read).
 * Without a database connection the facts that live on the user are still
 * shown and the counted ones are left out.
 */
async function loadTrust(
  { User, Reservation },
  member,
  { now = new Date(), isReady = () => mongoose.connection.readyState === 1 } = {},
) {
  let user = member && typeof member === "object" && "createdAt" in member ? member : null;
  const id = member && member._id ? member._id : member;
  const ready = Boolean(isReady());
  if (!user) {
    if (!ready || !mongoose.isValidObjectId(id)) return null;
    user = await User.findById(id).select("createdAt emailVerifiedAt").lean();
    if (!user) return null;
  }
  let stats = null;
  if (ready && Reservation && user._id) {
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [staysHosted, recent] = await Promise.all([
      Reservation.countDocuments({ host: user._id, status: "completed" }),
      Reservation.find({ host: user._id, createdAt: { $gte: since }, "statusHistory.from": "pending" })
        .sort({ createdAt: -1 })
        .limit(MAX_SCANNED)
        .select("statusHistory")
        .lean(),
    ]);
    stats = { staysHosted, ...summariseRequests(recent) };
  }
  return buildTrust({
    emailConfirmed: Boolean(user.emailVerifiedAt),
    memberSince: formatMonthYear(user.createdAt),
    stats,
  });
}

module.exports = {
  MIN_DECIDED,
  WINDOW_DAYS,
  MAX_SCANNED,
  summariseRequests,
  responseFrom,
  buildTrust,
  loadTrust,
  formatMonthYear,
};
