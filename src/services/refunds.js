// Refund calculation (P09-T03). Pure: no database, no clock (`now` is passed
// in). Money is integer paise. The rules are data in src/config/cancellation.js.
//
// A refund is CALCULATED AND RECORDED only; no money moves (payments are
// simulated until P16).
const { POLICIES, RULE_TEXT, HOUR_MS } = require("../config/cancellation");
const {
  DEFAULT_TIMEZONE,
  parseClockTime,
  zonedInstant,
} = require("../utils/dates");

/**
 * The instant check-in starts: the check-in date at the listing's check-in
 * time on the listing's own clock ("00:00" when the snapshot has no valid time).
 */
function checkInInstant(reservation) {
  const snap = reservation.listingSnapshot || {};
  const minutes = parseClockTime(snap.checkInTime);
  return zonedInstant(
    reservation.checkIn,
    minutes === null ? 0 : minutes,
    snap.timezone || DEFAULT_TIMEZONE,
  );
}

function bookedAtOf(reservation) {
  if (reservation.createdAt instanceof Date) return reservation.createdAt;
  const first = Array.isArray(reservation.statusHistory)
    ? reservation.statusHistory[0]
    : null;
  return first && first.at instanceof Date ? first.at : null;
}

const isMinor = (n) => Number.isSafeInteger(n) && n >= 0;

// total, one night's average price, and the price of the other nights.
function amountsOf(reservation) {
  const price = reservation.pricingSnapshot || {};
  const total = price.totalMinor;
  if (!isMinor(total))
    throw new TypeError("The booking has no total to refund from.");
  const nights =
    Number.isInteger(reservation.nights) && reservation.nights > 0
      ? reservation.nights
      : 1;
  const subtotal = isMinor(price.subtotalMinor) ? price.subtotalMinor : total;
  const firstNight = Math.min(
    isMinor(price.avgPerNightMinor)
      ? price.avgPerNightMinor
      : Math.round(subtotal / nights),
    subtotal,
  );
  return { total, firstNight, rest: subtotal - firstNight };
}

function ruleHolds(rule, { now, checkInAt, bookedAt }) {
  const when = rule.when;
  if (when.freeUntilHoursBeforeCheckIn !== undefined) {
    return (
      now.getTime() <=
      checkInAt.getTime() - when.freeUntilHoursBeforeCheckIn * HOUR_MS
    );
  }
  if (when.withinHoursOfBooking !== undefined) {
    if (!bookedAt) return false;
    return (
      now.getTime() - bookedAt.getTime() <=
        when.withinHoursOfBooking * HOUR_MS &&
      checkInAt.getTime() - now.getTime() >=
        when.minHoursBeforeCheckIn * HOUR_MS
    );
  }
  return when.before === "checkIn";
}

function retainedBy(keep, { total, firstNight, rest }) {
  switch (keep.kind) {
    case "nothing":
      return 0;
    case "everything":
      return total;
    case "firstNight":
      return firstNight + Math.ceil(rest * keep.restShare);
    case "refundShareOfTotal":
      return total - Math.floor(total * keep.share);
    default:
      throw new TypeError(`Unknown refund rule kind: ${keep.kind}`);
  }
}

// Until when a full refund still holds under the rule that applies (or null).
function fullRefundUntil(rule, { checkInAt, bookedAt }) {
  const when = rule.when;
  if (rule.keep.kind !== "nothing") return null;
  const dates = [];
  if (when.freeUntilHoursBeforeCheckIn !== undefined) {
    dates.push(
      checkInAt.getTime() - when.freeUntilHoursBeforeCheckIn * HOUR_MS,
    );
  }
  if (when.withinHoursOfBooking !== undefined && bookedAt) {
    dates.push(bookedAt.getTime() + when.withinHoursOfBooking * HOUR_MS);
    dates.push(checkInAt.getTime() - when.minHoursBeforeCheckIn * HOUR_MS);
  }
  if (!dates.length) return null;
  const earliest = new Date();
  earliest.setTime(Math.min(...dates));
  return earliest;
}

function result(policy, rule, total, retained, extra = {}) {
  const retainedMinor = Math.min(Math.max(retained, 0), total);
  return {
    policy: policy || null,
    rule,
    ruleText: RULE_TEXT[rule],
    totalMinor: total,
    refundMinor: total - retainedMinor,
    retainedMinor,
    fullRefundUntil: null,
    ...extra,
  };
}

/**
 * What a GUEST gets back if they cancel at `now`, under the listing's policy.
 * @param {string} policy "flexible" | "moderate" | "strict" (anything else: no refund promised)
 * @param {object} reservation checkIn (date-only Date), nights, createdAt,
 *   pricingSnapshot {totalMinor, subtotalMinor, avgPerNightMinor},
 *   listingSnapshot {timezone, checkInTime}
 * @param {Date} now
 * @returns {{ policy, rule, ruleText, totalMinor, refundMinor, retainedMinor, fullRefundUntil: Date|null, checkInAt: Date }}
 */
function refundFor(policy, reservation, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const amounts = amountsOf(reservation);
  const checkInAt = checkInInstant(reservation);
  const base = { checkInAt };
  const rules = Object.hasOwn(POLICIES, policy) ? POLICIES[policy] : null;
  if (!rules)
    return result(policy, "no_policy", amounts.total, amounts.total, base);
  if (now.getTime() >= checkInAt.getTime()) {
    return result(policy, "stay_started", amounts.total, amounts.total, base);
  }
  const context = { now, checkInAt, bookedAt: bookedAtOf(reservation) };
  for (const rule of rules) {
    if (!ruleHolds(rule, context)) continue;
    return result(
      policy,
      rule.id,
      amounts.total,
      retainedBy(rule.keep, amounts),
      {
        ...base,
        fullRefundUntil: fullRefundUntil(rule, context),
      },
    );
  }
  // Every policy ends with a rule that always holds; reaching this is a data error.
  throw new Error(`Policy ${policy} has no rule for this cancellation.`);
}

/**
 * The refund for one cancellation, whoever cancels:
 * - the host: always everything back;
 * - the guest, request not yet answered (pending): everything back;
 * - the guest, confirmed: refundFor(policy of the booking).
 */
function refundForCancellation({ reservation, actor, now }) {
  const { total } = amountsOf(reservation);
  const checkInAt = checkInInstant(reservation);
  const snap = reservation.listingSnapshot || {};
  const policy = snap.cancellationPolicy || null;
  if (actor === "host")
    return result(policy, "host_cancelled", total, 0, { checkInAt });
  if (actor !== "guest") throw new TypeError("actor must be guest or host");
  if (reservation.status === "pending")
    return result(policy, "request_withdrawn", total, 0, { checkInAt });
  return refundFor(policy, reservation, now);
}

module.exports = { refundFor, refundForCancellation, checkInInstant };
