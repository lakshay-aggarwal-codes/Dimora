// The host's overview (P13-T01): four tiles, each a number a host can act on
// and each linking to the list it comes from. No charts.
//
//   Waiting for you    pending requests whose hold is still running, and when the
//                      soonest one runs out            -> /host/reservations
//   Next 7 days        confirmed check-ins and check-outs from today to six days
//                      ahead                           -> /host/reservations#inbox-confirmed
//   Estimated earnings what the host would receive for confirmed and completed
//                      stays that START this month. An ESTIMATE: Dimora pays
//                      nothing out yet  -> /host/calendar
//   Occupancy          booked nights / (published listings x 30 - blocked nights)
//                      over the next 30 nights, from the night ledger -> /host/calendar
//
// "Host receivable" of a booking is the stored price lines `nights`,
// `weekend_nights` and `cleaning`: what the host sets. The guest service fee is
// Dimora's and the tax line is passed on, so neither is counted. This is a
// definition for an estimate, not an accounting rule (ADR-009: payments are
// simulated).
const {
  DEFAULT_TIMEZONE,
  addDays,
  addMonths,
  startOfMonth,
  todayIn,
} = require("../utils/dates");

const RECEIVABLE_CODES = Object.freeze([
  "nights",
  "weekend_nights",
  "cleaning",
]);
const WEEK_DAYS = 7;
const OCCUPANCY_DAYS = 30;
const LIST_LIMIT = 5;
const FETCH_LIMIT = 500;

const idText = (v) => String(v && v._id ? v._id : v);

/** What the host would receive for one stored price, in integer paise (0 if unreadable). */
function hostReceivableMinor(pricingSnapshot) {
  const lines =
    pricingSnapshot && Array.isArray(pricingSnapshot.lines)
      ? pricingSnapshot.lines
      : [];
  return lines
    .filter(
      (l) =>
        l &&
        RECEIVABLE_CODES.includes(l.code) &&
        Number.isSafeInteger(l.amountMinor) &&
        l.amountMinor > 0,
    )
    .reduce((total, l) => total + l.amountMinor, 0);
}

/** A whole percent, or null when there is nothing to divide by. */
function occupancyPercent(bookedNights, availableNights) {
  if (!(availableNights > 0)) return null;
  return Math.round((bookedNights / availableNights) * 100);
}

function guestName(reservation) {
  const g = reservation.guest;
  return g && typeof g === "object" && typeof g.toHexString !== "function"
    ? g.displayName || g.username || "A guest"
    : "A guest";
}

function stayRow(reservation, date) {
  const snap = reservation.listingSnapshot || {};
  return {
    id: idText(reservation._id),
    title: snap.title || "Your place",
    guest: guestName(reservation),
    guests: reservation.guests,
    date,
  };
}

/**
 * @param {{ ListingModel?, ReservationModel?, StayNightModel? }} deps
 * @param {*} hostId
 * @param {{ now?: Date }} [options]
 */
async function overview(
  {
    ListingModel = require("../models/listing"),
    ReservationModel = require("../models/reservation"),
    StayNightModel = require("../models/stayNight"),
  } = {},
  hostId,
  { now = new Date() } = {},
) {
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const weekEnd = addDays(today, WEEK_DAYS);
  const monthStart = startOfMonth(today);
  const nextMonth = addMonths(monthStart, 1);
  const horizon = addDays(today, OCCUPANCY_DAYS);

  const [listings, pending, week, earned] = await Promise.all([
    ListingModel.find({
      owner: hostId,
      deletedAt: null,
      status: { $in: ["published", "unpublished", "suspended"] },
    })
      .select("status")
      .lean(),
    ReservationModel.find({
      host: hostId,
      status: "pending",
      holdExpiresAt: { $gt: now },
    })
      .sort({ holdExpiresAt: 1, _id: 1 })
      .limit(FETCH_LIMIT)
      .select("holdExpiresAt")
      .lean(),
    ReservationModel.find({
      host: hostId,
      status: "confirmed",
      $or: [
        { checkIn: { $gte: today, $lt: weekEnd } },
        { checkOut: { $gte: today, $lt: weekEnd } },
      ],
    })
      .sort({ checkIn: 1, _id: 1 })
      .limit(FETCH_LIMIT)
      .populate("guest", "displayName username")
      .select("guest guests checkIn checkOut listingSnapshot")
      .lean(),
    ReservationModel.find({
      host: hostId,
      status: { $in: ["confirmed", "completed"] },
      checkIn: { $gte: monthStart, $lt: nextMonth },
    })
      .limit(FETCH_LIMIT)
      .select("pricingSnapshot")
      .lean(),
  ]);

  const inWindow = (date) => date >= today && date < weekEnd;
  const checkIns = week.filter((r) => inWindow(r.checkIn));
  const checkOuts = week.filter((r) => inWindow(r.checkOut));

  // Occupancy: published listings only; nights held by confirmed or completed
  // stays are booked, host blocks are not available; a pending request counts
  // as neither (it may still be answered no).
  const published = listings.filter((l) => l.status === "published");
  let booked = 0;
  let blocked = 0;
  if (published.length > 0) {
    const rows = (
      await StayNightModel.find({
        listing: { $in: published.map((l) => l._id) },
        date: { $gte: today, $lt: horizon },
      })
        .select("source holdExpiresAt")
        .lean()
    ).filter((r) => !(r.holdExpiresAt && r.holdExpiresAt <= now));
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.source.kind === "reservation")
          .map((r) => idText(r.source.id)),
      ),
    ];
    const statuses = new Map();
    if (ids.length > 0) {
      const docs = await ReservationModel.find({
        _id: { $in: ids },
        host: hostId,
      })
        .select("status")
        .lean();
      for (const d of docs) statuses.set(idText(d._id), d.status);
    }
    for (const row of rows) {
      if (row.source.kind === "block") blocked += 1;
      else if (
        ["confirmed", "completed"].includes(statuses.get(idText(row.source.id)))
      )
        booked += 1;
    }
  }
  const available = published.length * OCCUPANCY_DAYS - blocked;

  return {
    listingCount: listings.length,
    pending: {
      count: pending.length,
      soonestExpiry: pending.length > 0 ? pending[0].holdExpiresAt : null,
      capped: pending.length >= FETCH_LIMIT,
    },
    week: {
      days: WEEK_DAYS,
      checkIns: checkIns.length,
      checkOuts: checkOuts.length,
      upcomingCheckIns: checkIns
        .slice(0, LIST_LIMIT)
        .map((r) => stayRow(r, r.checkIn)),
      upcomingCheckOuts: checkOuts
        .slice(0, LIST_LIMIT)
        .map((r) => stayRow(r, r.checkOut)),
      capped: week.length >= FETCH_LIMIT,
    },
    earnings: {
      estimateMinor: earned.reduce(
        (t, r) => t + hostReceivableMinor(r.pricingSnapshot),
        0,
      ),
      stays: earned.length,
      monthStart,
      capped: earned.length >= FETCH_LIMIT,
    },
    occupancy: {
      days: OCCUPANCY_DAYS,
      percent: occupancyPercent(booked, available),
      bookedNights: booked,
      blockedNights: blocked,
      availableNights: Math.max(available, 0),
      listings: published.length,
    },
  };
}

module.exports = {
  overview,
  hostReceivableMinor,
  occupancyPercent,
  RECEIVABLE_CODES,
  WEEK_DAYS,
  OCCUPANCY_DAYS,
};
