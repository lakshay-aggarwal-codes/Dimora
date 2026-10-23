// Guest trips (P09-T01): the four tabs of /trips and the confirmation page of
// one booking. Reads only; moving a booking between statuses is
// services/reservations.js. Everything a view needs is worked out here, so the
// views only print.
//
// Tabs (a booking is in exactly one):
//   Upcoming   confirmed, check-out after today
//   Pending    waiting for the host, hold still running
//   Past       completed, or confirmed with check-out passed (the sweeper has
//              not marked it completed yet)
//   Cancelled  declined, expired, cancelled by either side, or a request whose
//              hold ran out and the sweeper has not expired yet
// "Today" is the date in the app's default time zone (Asia/Kolkata).
const {
  CANCELLATION_POLICIES,
  CANCELLATION_TERMS,
} = require("../config/constants");
const { DEFAULT_TIMEZONE, todayIn, formatDateOnly } = require("../utils/dates");
const { RULE_TEXT } = require("../config/cancellation");
const { cancelOffer } = require("./cancellations");

const TABS = Object.freeze([
  { key: "upcoming", label: "Upcoming" },
  { key: "pending", label: "Pending" },
  { key: "past", label: "Past" },
  { key: "cancelled", label: "Cancelled" },
]);
const TAB_KEYS = TABS.map((t) => t.key);
const PAGE_SIZE = 10;
const CLOSED = [
  "declined",
  "expired",
  "cancelled_by_guest",
  "cancelled_by_host",
];

const parseTab = (raw) =>
  typeof raw === "string" && TAB_KEYS.includes(raw) ? raw : "upcoming";

function parsePage(raw) {
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return n >= 1 ? n : 1;
}

/** MongoDB filter and sort of one tab, for one guest. */
function tabQuery(tab, guestId, { now, today }) {
  const base = { guest: guestId };
  switch (tab) {
    case "upcoming":
      return {
        filter: { ...base, status: "confirmed", checkOut: { $gt: today } },
        sort: { checkIn: 1, _id: 1 },
      };
    case "pending":
      return {
        filter: { ...base, status: "pending", holdExpiresAt: { $gt: now } },
        sort: { holdExpiresAt: 1, _id: 1 },
      };
    case "past":
      return {
        filter: {
          ...base,
          $or: [
            { status: "completed" },
            { status: "confirmed", checkOut: { $lte: today } },
          ],
        },
        sort: { checkOut: -1, _id: -1 },
      };
    case "cancelled":
      return {
        filter: {
          ...base,
          $or: [
            { status: { $in: CLOSED } },
            { status: "pending", holdExpiresAt: { $lte: now } },
          ],
        },
        sort: { updatedAt: -1, _id: -1 },
      };
    default:
      throw new TypeError(`unknown tab: ${tab}`);
  }
}

/** The tab one booking belongs to (the same rules as tabQuery). */
function tabOf(reservation, { now = new Date() } = {}) {
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const { status } = reservation;
  if (status === "completed") return "past";
  if (status === "confirmed")
    return reservation.checkOut > today ? "upcoming" : "past";
  if (status === "pending") {
    return reservation.holdExpiresAt && reservation.holdExpiresAt > now
      ? "pending"
      : "cancelled";
  }
  return "cancelled";
}

const STATUS_LABELS = {
  pending: { label: "Waiting for the host", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  completed: { label: "Completed", tone: "secondary" },
  declined: { label: "Declined by the host", tone: "danger" },
  expired: { label: "Request expired", tone: "secondary" },
  cancelled_by_host: { label: "Cancelled by the host", tone: "danger" },
};

function statusInfo(
  reservation,
  { viewerIsGuest = true, now = new Date() } = {},
) {
  if (reservation.status === "cancelled_by_guest") {
    return {
      label: viewerIsGuest ? "Cancelled by you" : "Cancelled by the guest",
      tone: "secondary",
    };
  }
  if (
    reservation.status === "pending" &&
    !(reservation.holdExpiresAt && reservation.holdExpiresAt > now)
  ) {
    return STATUS_LABELS.expired;
  }
  return (
    STATUS_LABELS[reservation.status] || {
      label: reservation.status,
      tone: "secondary",
    }
  );
}

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const weekdayFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  timeZone: "UTC",
});

/** "12 Nov 2026" from a date-only Date. */
const formatStayDate = (date) => dateFormat.format(date);
const formatStayWeekday = (date) => weekdayFormat.format(date);

function formatInstant(instant, timeZone = DEFAULT_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(instant);
  } catch {
    return formatInstant(instant, DEFAULT_TIMEZONE);
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The words for one stored breakdown line (the snapshot keeps codes and numbers). */
function lineLabel(line, formatMoney, currency) {
  switch (line.code) {
    case "nights":
      return `${formatMoney(line.unitMinor, currency)} × ${plural(line.quantity, "night", "nights")}`;
    case "weekend_nights":
      return `${formatMoney(line.unitMinor, currency)} × ${plural(line.quantity, "weekend night", "weekend nights")}`;
    case "cleaning":
      return "Cleaning fee";
    case "service_fee":
      return "Service fee";
    case "tax":
      return line.included ? "Taxes (included in the price)" : "Taxes";
    default:
      return "Other charges";
  }
}

// A populated document, as opposed to a bare ObjectId or string id (an ObjectId
// has an `_id` getter in some driver versions, so `_id` alone proves nothing).
const isDocument = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.toHexString !== "function";

/** The note the host left when declining (status history), or "". */
function declineReasonOf(reservation) {
  if (reservation.status !== "declined") return "";
  const history = Array.isArray(reservation.statusHistory) ? reservation.statusHistory : [];
  const entry = [...history].reverse().find((h) => h && h.to === "declined" && h.note);
  return entry ? String(entry.note) : "";
}

/**
 * How a cancelled booking ended (P09-T03): who cancelled, the reason they gave
 * and the refund that was worked out (recorded, simulated: no money moves).
 */
function cancelledInfo(reservation, { formatMoney, currency }) {
  if (
    reservation.status !== "cancelled_by_guest" &&
    reservation.status !== "cancelled_by_host"
  )
    return null;
  const refund = reservation.refund;
  const hasRefund = refund && Number.isSafeInteger(refund.amountMinor);
  return {
    by: reservation.status === "cancelled_by_host" ? "host" : "guest",
    reason: reservation.cancelReason ? String(reservation.cancelReason) : "",
    refund: hasRefund
      ? {
          amountText: formatMoney(refund.amountMinor, currency),
          keptText: formatMoney(refund.retainedMinor || 0, currency),
          full: refund.amountMinor === refund.totalMinor,
          none: refund.amountMinor === 0,
          ruleText: RULE_TEXT[refund.rule] || "",
        }
      : null,
  };
}

const idText = (value) => String(value && value._id ? value._id : value);

/** A short code a guest and a host can quote: DIM-1A2B3C4D. */
const referenceOf = (reservation) =>
  `DIM-${idText(reservation._id).slice(-8).toUpperCase()}`;

function policyInfo(policy) {
  const found = CANCELLATION_POLICIES.find((p) => p.value === policy);
  if (!found) return null;
  return { label: found.label, terms: CANCELLATION_TERMS[policy] || "" };
}

/** One row of a tab. */
function describeRow(reservation, { now = new Date() } = {}) {
  const snap = reservation.listingSnapshot || {};
  const info = statusInfo(reservation, { viewerIsGuest: true, now });
  const price = reservation.pricingSnapshot || {};
  return {
    id: idText(reservation._id),
    reference: referenceOf(reservation),
    listingTitle: snap.title || "A place on Dimora",
    city: snap.city || "",
    coverUrl: snap.coverUrl || "",
    checkIn: formatStayDate(reservation.checkIn),
    checkOut: formatStayDate(reservation.checkOut),
    nights: reservation.nights,
    guests: reservation.guests,
    statusLabel: info.label,
    tone: info.tone,
    totalMinor: Number.isSafeInteger(price.totalMinor)
      ? price.totalMinor
      : null,
    currency: price.currency || "INR",
    holdsUntil:
      reservation.status === "pending" && reservation.holdExpiresAt
        ? formatInstant(reservation.holdExpiresAt, snap.timezone)
        : null,
  };
}

/**
 * One page of a guest's trips in one tab, with the count of every tab.
 * @param {{ ReservationModel?: object }} deps
 */
async function listTrips(
  { ReservationModel = require("../models/reservation") } = {},
  guestId,
  { tab, page, now = new Date() } = {},
) {
  const key = parseTab(tab);
  const context = { now, today: todayIn(DEFAULT_TIMEZONE, now) };
  const queries = Object.fromEntries(
    TAB_KEYS.map((k) => [k, tabQuery(k, guestId, context)]),
  );
  const counts = await Promise.all(
    TAB_KEYS.map((k) => ReservationModel.countDocuments(queries[k].filter)),
  );
  const countOf = Object.fromEntries(TAB_KEYS.map((k, i) => [k, counts[i]]));
  const total = countOf[key];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(parsePage(String(page)), totalPages);
  const rows =
    total === 0
      ? []
      : await ReservationModel.find(queries[key].filter)
          .sort(queries[key].sort)
          .skip((current - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .lean();
  return {
    tab: key,
    tabs: TABS.map((t) => ({ ...t, count: countOf[t.key] })),
    page: current,
    totalPages,
    total,
    items: rows.map((r) => describeRow(r, { now })),
  };
}

/**
 * Everything the confirmation page shows.
 * `reservation` has `listing`, `host` and `guest` populated (any may be missing
 * if the document was deleted; the snapshots still carry the contract).
 * Who may see it is the caller's `can("reservation:view")`.
 * What is shown only after confirmation (host contact, exact address) is
 * decided here, from the status, never by the view.
 * @param {object} reservation
 * @param {{ viewerRole: "guest"|"host"|"admin", formatMoney: Function, now?: Date }} options
 */
function describeTrip(
  reservation,
  { viewerRole, formatMoney, now = new Date() },
) {
  const snap = reservation.listingSnapshot || {};
  const price = reservation.pricingSnapshot || {};
  const currency = price.currency || "INR";
  const listing = isDocument(reservation.listing) ? reservation.listing : null;
  const host = isDocument(reservation.host) ? reservation.host : null;
  const guest = isDocument(reservation.guest) ? reservation.guest : null;
  const viewerIsGuest = viewerRole === "guest";
  const info = statusInfo(reservation, { viewerIsGuest, now });
  const revealed =
    reservation.status === "confirmed" || reservation.status === "completed";

  const lines = (price.lines || []).map((line) => ({
    label: lineLabel(line, formatMoney, currency),
    amount: formatMoney(line.amountMinor, currency),
    included: Boolean(line.included),
  }));

  let address = null;
  let mapUrl = null;
  if (revealed && listing) {
    const a = listing.address || {};
    const parts = [
      a.line1,
      a.city,
      [a.state, a.postalCode].filter(Boolean).join(" "),
      a.country,
    ].filter((p) => p && String(p).trim());
    address =
      parts.length > 0
        ? parts
        : listing.location
          ? [listing.location, listing.country].filter(Boolean)
          : null;
    const c = listing.geometry && listing.geometry.coordinates;
    if (Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)) {
      mapUrl = `https://www.openstreetmap.org/?mlat=${c[1]}&mlon=${c[0]}#map=17/${c[1]}/${c[0]}`;
    }
  }

  const holdActive =
    reservation.status === "pending" &&
    reservation.holdExpiresAt &&
    reservation.holdExpiresAt > now;
  return {
    id: idText(reservation._id),
    reference: referenceOf(reservation),
    status: reservation.status,
    statusLabel: info.label,
    tone: info.tone,
    tab: tabOf(reservation, { now }),
    viewerRole,
    listing: {
      id: listing ? idText(listing) : null,
      title: snap.title || (listing && listing.title) || "A place on Dimora",
      city: snap.city || "",
      coverUrl: snap.coverUrl || "",
      url:
        listing && !listing.deletedAt ? `/listings/${idText(listing)}` : null,
    },
    checkIn: formatStayDate(reservation.checkIn),
    checkInWeekday: formatStayWeekday(reservation.checkIn),
    checkOut: formatStayDate(reservation.checkOut),
    checkOutWeekday: formatStayWeekday(reservation.checkOut),
    checkInIso: formatDateOnly(reservation.checkIn),
    checkOutIso: formatDateOnly(reservation.checkOut),
    checkInTime: snap.checkInTime || "",
    checkOutTime: snap.checkOutTime || "",
    nights: reservation.nights,
    guests: reservation.guests,
    lines,
    totalMinor: price.totalMinor,
    totalText: formatMoney(price.totalMinor, currency),
    avgPerNightText: Number.isSafeInteger(price.avgPerNightMinor)
      ? formatMoney(price.avgPerNightMinor, currency)
      : null,
    taxNote: price.taxIncluded ? "Taxes are included in the price shown." : "",
    houseRules: snap.noSpecialRules ? "" : snap.houseRules || "",
    noSpecialRules: Boolean(snap.noSpecialRules) || !snap.houseRules,
    cancellation: policyInfo(snap.cancellationPolicy),
    instantBook: Boolean(snap.instantBook),
    holdsUntil: holdActive
      ? formatInstant(reservation.holdExpiresAt, snap.timezone)
      : null,
    // Shown only once the booking is confirmed (or done), and only to people who may see the booking.
    revealed,
    hostContact:
      revealed && viewerIsGuest && host
        ? {
            name: host.displayName || host.username,
            email: host.email || null,
            profileUrl: `/users/${idText(host)}`,
          }
        : null,
    guestName:
      !viewerIsGuest && guest ? guest.displayName || guest.username : null,
    address,
    mapUrl,
    declineReason: declineReasonOf(reservation),
    cancelled: cancelledInfo(reservation, { formatMoney, currency }),
    // The cancel button and what it would refund, for the guest only (the host
    // cancels from the booking requests page).
    cancel: viewerIsGuest
      ? cancelOffer(reservation, { actor: "guest", now, formatMoney, formatInstant })
      : null,
    paymentSimulated: true,
  };
}

module.exports = {
  TABS,
  PAGE_SIZE,
  parseTab,
  parsePage,
  tabQuery,
  tabOf,
  statusInfo,
  describeRow,
  describeTrip,
  listTrips,
  lineLabel,
  referenceOf,
  formatStayDate,
  formatInstant,
};
