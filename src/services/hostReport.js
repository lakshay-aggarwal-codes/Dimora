// Earnings and occupancy report for one host (P13-T04): one row per listing
// for a range of whole months, as a page and as a CSV.
//
// Definitions (the same as the overview tiles, P13-T01; an ESTIMATE, nothing is
// paid out - ADR-009):
//   bookings        confirmed or completed stays whose check-in is in the range
//   earnings        host receivable of those stays (nights + weekend nights +
//                   cleaning; the guest service fee and tax are not the host's)
//   nights booked   nights of confirmed or completed stays that fall inside the
//                   range, whichever month the stay started in
//   nights blocked  nights the host blocked inside the range
//   occupancy       booked / (days in the range - blocked), whole percent,
//                   at most 100; none when every night is blocked
// Requests still waiting, declined, expired and cancelled stays are not counted.
// Future nights only count once reserved. Days are India time (ADR-008).
// Money is integer paise per currency; totals are per currency, never mixed.
const {
  DEFAULT_TIMEZONE,
  addDays,
  addMonths,
  formatDateOnly,
  formatMonthKey,
  parseMonthKey,
  startOfMonth,
  todayIn,
} = require("../utils/dates");
const { ValidationError } = require("../utils/errors");
const { hostReceivableMinor } = require("./hostOverview");

const MAX_MONTHS = 12; // longest range
const LOOK_BACK_MONTHS = 24; // earliest month offered
const LOOK_AHEAD_MONTHS = 12; // latest month offered
const DEFAULT_MONTHS = 3;
const FETCH_LIMIT = 5000;
const MS_DAY = 24 * 60 * 60 * 1000;

const idText = (v) => String(v && v._id ? v._id : v);
const monthDiff = (a, b) =>
  (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

/**
 * The range from the query: `from` and `to` are "YYYY-MM" (both optional, the
 * last 3 months by default). Throws ValidationError for anything else.
 * @returns {{from: Date, to: Date, start: Date, end: Date, days: number, fromKey: string, toKey: string}}
 *   start is the first day, end the first day AFTER the range (exclusive).
 */
function parseRange(query = {}, { now = new Date() } = {}) {
  const thisMonth = startOfMonth(todayIn(DEFAULT_TIMEZONE, now));
  const one = (v) => (typeof v === "string" ? v : undefined);
  const rawFrom = one(query.from);
  const rawTo = one(query.to);
  if ((query.from !== undefined && rawFrom === undefined) || (query.to !== undefined && rawTo === undefined)) {
    throw new ValidationError("Choose the months as YYYY-MM.");
  }
  const badMonth = () => new ValidationError("Choose the months as YYYY-MM, for example 2026-10.");
  const to = rawTo ? parseMonthKey(rawTo) : thisMonth;
  if (!to) throw badMonth();
  const from = rawFrom ? parseMonthKey(rawFrom) : addMonths(to, -(DEFAULT_MONTHS - 1));
  if (!from) throw badMonth();
  if (monthDiff(from, to) < 0) throw new ValidationError("The first month cannot be after the last month.");
  if (monthDiff(from, to) + 1 > MAX_MONTHS) {
    throw new ValidationError(`A report can cover at most ${MAX_MONTHS} months.`);
  }
  if (monthDiff(from, thisMonth) > LOOK_BACK_MONTHS || monthDiff(thisMonth, to) > LOOK_AHEAD_MONTHS) {
    throw new ValidationError(
      `Choose months from the last ${LOOK_BACK_MONTHS} months to the next ${LOOK_AHEAD_MONTHS}.`,
    );
  }
  const start = from;
  const end = addMonths(to, 1);
  return {
    from,
    to,
    start,
    end,
    days: Math.round((end.getTime() - start.getTime()) / MS_DAY),
    fromKey: formatMonthKey(from),
    toKey: formatMonthKey(to),
  };
}

/** Nights of [checkIn, checkOut) that lie inside [start, end). */
function overlapNights(checkIn, checkOut, start, end) {
  const lo = Math.max(checkIn.getTime(), start.getTime());
  const hi = Math.min(checkOut.getTime(), end.getTime());
  return hi > lo ? Math.round((hi - lo) / MS_DAY) : 0;
}

/** A whole percent (0 to 100) or null when nothing was available. */
function occupancyPercent(booked, available) {
  if (!(available > 0)) return null;
  return Math.min(100, Math.round((booked / available) * 100));
}

async function buildReport(
  {
    ListingModel = require("../models/listing"),
    ReservationModel = require("../models/reservation"),
    StayNightModel = require("../models/stayNight"),
  } = {},
  hostId,
  query,
  { now = new Date() } = {},
) {
  const range = parseRange(query, { now });
  const { start, end, days } = range;

  const listings = await ListingModel.find({
    owner: hostId,
    deletedAt: null,
    status: { $in: ["published", "unpublished", "suspended"] },
  })
    .sort({ title: 1, _id: 1 })
    .limit(50)
    .select("title status pricing.currency")
    .lean();
  const ids = listings.map((l) => l._id);

  const [stays, blocks] = ids.length
    ? await Promise.all([
        ReservationModel.find({
          host: hostId,
          listing: { $in: ids },
          status: { $in: ["confirmed", "completed"] },
          checkIn: { $lt: end },
          checkOut: { $gt: start },
        })
          .limit(FETCH_LIMIT)
          .select("listing checkIn checkOut pricingSnapshot")
          .lean(),
        StayNightModel.find({
          listing: { $in: ids },
          "source.kind": "block",
          date: { $gte: start, $lt: end },
        })
          .limit(FETCH_LIMIT * 10)
          .select("listing")
          .lean(),
      ])
    : [[], []];

  const byListing = new Map(
    listings.map((l) => [
      idText(l._id),
      {
        id: idText(l._id),
        title: l.title,
        status: l.status,
        currency: (l.pricing && l.pricing.currency) || "INR",
        bookings: 0,
        nightsBooked: 0,
        nightsBlocked: 0,
        earningsMinor: 0,
      },
    ]),
  );

  for (const stay of stays) {
    const row = byListing.get(idText(stay.listing));
    if (!row) continue;
    const snap = stay.pricingSnapshot || {};
    if (snap.currency) row.currency = snap.currency;
    row.nightsBooked += overlapNights(stay.checkIn, stay.checkOut, start, end);
    if (stay.checkIn >= start && stay.checkIn < end) {
      row.bookings += 1;
      row.earningsMinor += hostReceivableMinor(snap);
    }
  }
  for (const block of blocks) {
    const row = byListing.get(idText(block.listing));
    if (row) row.nightsBlocked += 1;
  }

  const rows = [...byListing.values()].map((row) => {
    const available = Math.max(0, days - row.nightsBlocked);
    return {
      ...row,
      nightsAvailable: available,
      occupancy: occupancyPercent(row.nightsBooked, available),
    };
  });

  // Totals per currency; occupancy over the listings in that currency.
  const totals = new Map();
  for (const row of rows) {
    const t = totals.get(row.currency) || {
      currency: row.currency,
      listings: 0,
      bookings: 0,
      nightsBooked: 0,
      nightsAvailable: 0,
      earningsMinor: 0,
    };
    t.listings += 1;
    t.bookings += row.bookings;
    t.nightsBooked += row.nightsBooked;
    t.nightsAvailable += row.nightsAvailable;
    t.earningsMinor += row.earningsMinor;
    totals.set(row.currency, t);
  }

  return {
    range: {
      fromKey: range.fromKey,
      toKey: range.toKey,
      firstDay: formatDateOnly(start),
      lastDay: formatDateOnly(addDays(end, -1)),
      days,
    },
    rows,
    totals: [...totals.values()].map((t) => ({
      ...t,
      occupancy: occupancyPercent(t.nightsBooked, t.nightsAvailable),
    })),
    capped: stays.length >= FETCH_LIMIT,
    listingsShown: listings.length,
  };
}

// ---- CSV ----------------------------------------------------------------

/** Integer minor units as a plain decimal string ("1234.50"), no float involved. */
function minorToDecimal(minor, digits = 2) {
  if (!Number.isSafeInteger(minor)) throw new TypeError("minor must be a safe integer");
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = String(Math.abs(minor)).padStart(digits + 1, "0");
  return `${sign}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}

/**
 * One CSV cell. Quoted per RFC 4180, and a text that a spreadsheet would run as
 * a formula (starts with = + - @ or a tab/return) is made safe with a leading
 * apostrophe.
 */
function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Decimal places of a currency's minor unit (2 for INR, 0 for JPY). */
const currencyDigits = (currency) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;

const CSV_HEADER = [
  "listing",
  "listing_id",
  "status",
  "period_first_day",
  "period_last_day",
  "bookings_started",
  "nights_booked",
  "nights_blocked",
  "nights_available",
  "occupancy_percent",
  "earnings_estimate",
  "currency",
];

/** The report as CSV text: UTF-8 with a byte-order mark (so Excel reads it right), CRLF lines. */
function toCsv(report) {
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const r of report.rows) {
    lines.push(
      [
        r.title,
        r.id,
        r.status,
        report.range.firstDay,
        report.range.lastDay,
        r.bookings,
        r.nightsBooked,
        r.nightsBlocked,
        r.nightsAvailable,
        r.occupancy === null ? "" : r.occupancy,
        minorToDecimal(r.earningsMinor, currencyDigits(r.currency)),
        r.currency,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

module.exports = {
  buildReport,
  parseRange,
  overlapNights,
  occupancyPercent,
  minorToDecimal,
  currencyDigits,
  csvCell,
  toCsv,
  CSV_HEADER,
  MAX_MONTHS,
  DEFAULT_MONTHS,
};
