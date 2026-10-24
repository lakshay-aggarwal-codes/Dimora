// The host's reservation calendar (P13-T02): all of a host's listings in one
// month, one row per listing, one cell per night, coloured (and worded) by what
// holds the night. Read-only; blocking nights is the per-listing calendar of
// P07-T03 and answering requests is the inbox of P09-T02.
//
// Source of truth for the nights is the night ledger (ADR-004), as in the
// per-listing calendar: a reserved night, a live request hold and a host block
// are all rows in it; a hold that has run out counts as free. The reservations
// behind the ledger rows give each cell its status and its link. Only this
// host's reservations are read.
//
//   monthOverview({ ... }, hostId, monthValue, { now }) -> plain data for the view
const {
  BOOKING_WINDOW,
  DEFAULT_TIMEZONE,
  addDays,
  addMonths,
  daysInMonth,
  formatDateOnly,
  formatMonthKey,
  isAfter,
  isBefore,
  isoWeekday,
  parseMonthKey,
  startOfMonth,
  todayIn,
} = require("../utils/dates");

const MONTHS_BACK = 12;
const MAX_LISTINGS = 50;
const SHOWN_STATUSES = ["published", "unpublished", "suspended"]; // not drafts

const MONTH_NAMES = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);
const WEEKDAYS = Object.freeze([
  { short: "M", long: "Monday" },
  { short: "T", long: "Tuesday" },
  { short: "W", long: "Wednesday" },
  { short: "T", long: "Thursday" },
  { short: "F", long: "Friday" },
  { short: "S", long: "Saturday" },
  { short: "S", long: "Sunday" },
]);

// What holds a night. `letter` is a visual hint only: the state is always also
// written in words (never colour or a letter alone).
const STATES = Object.freeze({
  requested: {
    letter: "R",
    label: "Request",
    word: "request awaiting your answer",
  },
  booked: { letter: "B", label: "Booked", word: "booked" },
  stayed: { letter: "S", label: "Stayed", word: "stay completed" },
  blocked: { letter: "X", label: "Blocked", word: "blocked by you" },
});

const idText = (v) => String(v && v._id ? v._id : v);

function monthBounds(today) {
  return {
    min: addMonths(startOfMonth(today), -MONTHS_BACK),
    max: startOfMonth(addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS)),
  };
}

/** The month asked for (YYYY-MM), else this month, kept inside the bounds. */
function resolveMonth(value, today) {
  const { min, max } = monthBounds(today);
  let month = parseMonthKey(value) || startOfMonth(today);
  if (isBefore(month, min)) month = min;
  if (isAfter(month, max)) month = max;
  return month;
}

function stateOf(row, reservation) {
  if (row.source.kind === "block") return "blocked";
  if (!reservation) return "booked";
  if (reservation.status === "pending") return "requested";
  if (reservation.status === "completed") return "stayed";
  return "booked";
}

/**
 * @param {{ ListingModel?, StayNightModel?, ReservationModel? }} deps
 * @param {*} hostId  the signed-in user's id
 * @param {string} [monthValue]  "YYYY-MM"
 * @param {{ now?: Date }} [options]
 */
async function monthOverview(
  {
    ListingModel = require("../models/listing"),
    StayNightModel = require("../models/stayNight"),
    ReservationModel = require("../models/reservation"),
  } = {},
  hostId,
  monthValue,
  { now = new Date() } = {},
) {
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const { min, max } = monthBounds(today);
  const month = resolveMonth(monthValue, today);
  const next = addMonths(month, 1);
  const monthKey = formatMonthKey(month);

  const found = await ListingModel.find({
    owner: hostId,
    deletedAt: null,
    status: { $in: SHOWN_STATUSES },
  })
    .select("title status")
    .sort({ title: 1, _id: 1 })
    .limit(MAX_LISTINGS + 1)
    .lean();
  const truncated = found.length > MAX_LISTINGS;
  const listings = found.slice(0, MAX_LISTINGS);

  let nights = [];
  let reservations = new Map();
  if (listings.length > 0) {
    nights = (
      await StayNightModel.find({
        listing: { $in: listings.map((l) => l._id) },
        date: { $gte: month, $lt: next },
      })
        .select("listing date source holdExpiresAt")
        .lean()
    ).filter((row) => !(row.holdExpiresAt && row.holdExpiresAt <= now)); // a lapsed hold is free
    const ids = [
      ...new Set(
        nights
          .filter((n) => n.source.kind === "reservation")
          .map((n) => idText(n.source.id)),
      ),
    ];
    if (ids.length > 0) {
      const docs = await ReservationModel.find({
        _id: { $in: ids },
        host: hostId,
      })
        .select("status guest checkIn checkOut")
        .populate("guest", "displayName username")
        .lean();
      reservations = new Map(docs.map((r) => [idText(r._id), r]));
    }
  }
  const byNight = new Map(
    nights.map((n) => [`${idText(n.listing)}|${n.date.getTime()}`, n]),
  );

  const days = [];
  for (let i = 0; i < daysInMonth(month); i += 1) {
    const date = addDays(month, i);
    const weekday = isoWeekday(date);
    days.push({
      day: date.getUTCDate(),
      iso: formatDateOnly(date),
      weekday: WEEKDAYS[weekday],
      weekend: weekday >= 5,
      today: date.getTime() === today.getTime(),
      date,
    });
  }

  const totals = { requested: 0, booked: 0, stayed: 0, blocked: 0 };
  const rows = listings.map((listing) => {
    const counts = { requested: 0, booked: 0, stayed: 0, blocked: 0 };
    const cells = days.map((day) => {
      const row = byNight.get(`${idText(listing._id)}|${day.date.getTime()}`);
      const dayWords = `${WEEKDAYS[isoWeekday(day.date)].long} ${day.day} ${MONTH_NAMES[month.getUTCMonth()]}`;
      if (!row)
        return {
          state: "free",
          day: day.day,
          today: day.today,
          srLabel: `${dayWords}: available`,
        };
      const reservation =
        row.source.kind === "reservation"
          ? reservations.get(idText(row.source.id))
          : null;
      const state = stateOf(row, reservation);
      counts[state] += 1;
      totals[state] += 1;
      const guest =
        reservation &&
        reservation.guest &&
        typeof reservation.guest === "object"
          ? reservation.guest.displayName || reservation.guest.username
          : null;
      return {
        state,
        letter: STATES[state].letter,
        day: day.day,
        today: day.today,
        href: reservation
          ? `/trips/${idText(reservation._id)}`
          : state === "blocked"
            ? `/host/listings/${idText(listing._id)}/calendar?month=${monthKey}`
            : null,
        srLabel: `${dayWords}: ${STATES[state].word}${guest ? `, guest ${guest}` : ""}`,
      };
    });
    return {
      listing: {
        id: idText(listing._id),
        title: listing.title,
        status: listing.status,
        calendarUrl: `/host/listings/${idText(listing._id)}/calendar?month=${monthKey}`,
      },
      cells,
      counts,
    };
  });

  return {
    monthKey,
    label: `${MONTH_NAMES[month.getUTCMonth()]} ${month.getUTCFullYear()}`,
    prevKey: isAfter(month, min) ? formatMonthKey(addMonths(month, -1)) : null,
    nextKey: isBefore(month, max) ? formatMonthKey(addMonths(month, 1)) : null,
    days: days.map((d) => ({
      day: d.day,
      iso: d.iso,
      weekday: d.weekday,
      weekend: d.weekend,
      today: d.today,
    })),
    rows,
    totals,
    truncated,
    limit: MAX_LISTINGS,
    legend: Object.entries(STATES).map(([key, s]) => ({
      key,
      letter: s.letter,
      label: s.label,
      word: s.word,
    })),
  };
}

module.exports = {
  monthOverview,
  resolveMonth,
  monthBounds,
  STATES,
  MAX_LISTINGS,
  MONTHS_BACK,
};
