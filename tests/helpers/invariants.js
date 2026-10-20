// Ledger / reservation consistency checker (P07-T05), used by every booking
// test. `findViolations` is pure (arrays in, messages out), so it works with
// the in-memory fakes and with rows read from MongoDB (`checkDatabase`).
//
//   (a) a night has one owner                      (listing, date) never repeats
//   (b) a reservation that holds nights (pending, confirmed, completed) has
//       exactly one ledger row per night, on its own dates, in its own listing
//   (c) no ledger row belongs to a reservation that released its nights
//       (declined, expired, cancelled), or to no reservation at all
//   (d) a pending reservation has a hold, a confirmed one has none; the rows
//       carry the reservation's hold
const { holdsNights } = require("../../src/services/stateMachine");

const DAY = 86400000;
const dayKey = (d) => new Date(d).getTime();
const idKey = (v) => String(v && v._id ? v._id : v);

/**
 * @param {object[]} reservations  { _id, listing, checkIn, checkOut, nights, status, holdExpiresAt? }
 * @param {object[]} nights        { listing, date, source: { kind, id }, holdExpiresAt? }
 * @param {{ blocks?: boolean }} [options] blocks: ledger rows of kind "block" are allowed
 * @returns {string[]} what is wrong; empty when consistent
 */
function findViolations(reservations, nights) {
  const problems = [];

  const seen = new Set();
  for (const row of nights) {
    const k = `${idKey(row.listing)}|${dayKey(row.date)}`;
    if (seen.has(k)) problems.push(`(a) night owned twice: ${k}`);
    seen.add(k);
  }

  const byReservation = new Map();
  for (const row of nights) {
    if (row.source.kind !== "reservation") continue;
    const id = idKey(row.source.id);
    if (!byReservation.has(id)) byReservation.set(id, []);
    byReservation.get(id).push(row);
  }
  const reservationById = new Map(reservations.map((r) => [idKey(r._id), r]));

  for (const [id, rows] of byReservation) {
    const reservation = reservationById.get(id);
    if (!reservation) problems.push(`(c) ledger rows for a missing reservation ${id}`);
    else if (!holdsNights(reservation.status)) {
      problems.push(`(c) ${rows.length} ledger row(s) for ${reservation.status} reservation ${id}`);
    }
  }

  for (const reservation of reservations) {
    const id = idKey(reservation._id);
    if (!holdsNights(reservation.status)) continue;
    const rows = byReservation.get(id) || [];
    const expected = [];
    for (let t = dayKey(reservation.checkIn); t < dayKey(reservation.checkOut); t += DAY) expected.push(t);
    const got = rows.map((r) => dayKey(r.date)).sort((x, y) => x - y);
    if (got.length !== expected.length || got.some((t, i) => t !== expected[i])) {
      problems.push(`(b) reservation ${id} (${reservation.status}) has ${got.length} ledger rows, expected ${expected.length} nights`);
    }
    if (rows.some((r) => idKey(r.listing) !== idKey(reservation.listing))) {
      problems.push(`(b) reservation ${id} has ledger rows in another listing`);
    }
    if (reservation.status === "pending") {
      if (!reservation.holdExpiresAt) problems.push(`(d) pending reservation ${id} has no hold`);
      else if (rows.some((r) => !r.holdExpiresAt || dayKey(r.holdExpiresAt) !== dayKey(reservation.holdExpiresAt))) {
        problems.push(`(d) pending reservation ${id}: ledger hold differs from the reservation's`);
      }
    } else {
      if (reservation.holdExpiresAt) problems.push(`(d) ${reservation.status} reservation ${id} still has a hold`);
      if (rows.some((r) => r.holdExpiresAt)) problems.push(`(d) ${reservation.status} reservation ${id} has ledger rows that can expire`);
    }
  }
  return problems;
}

function expectConsistent(reservations, nights) {
  expect(findViolations(reservations, nights)).toEqual([]);
}

/** Reads both collections of the connected test database and checks them. */
async function checkDatabase() {
  const Reservation = require("../../src/models/reservation");
  const StayNight = require("../../src/models/stayNight");
  const [reservations, nights] = await Promise.all([
    Reservation.find({}).lean(),
    StayNight.find({}).lean(),
  ]);
  return findViolations(reservations, nights);
}

module.exports = { findViolations, expectConsistent, checkDatabase };
