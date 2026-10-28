// Platform summary for the admin landing page (P14-T05): real counts, read
// straight from the database on each visit. Read-only; writes nothing.
const User = require("../models/user");
const Listing = require("../models/listing");
const Reservation = require("../models/reservation");
const Report = require("../models/report");
const { STATUSES: RESERVATION_STATUSES } = require("./stateMachine");

/** { status: count } for every value in `all`, zero when there are none. */
async function countBy(Model, field, all, match = {}) {
  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  const found = new Map(rows.map((r) => [r._id, r.count]));
  const out = {};
  for (const value of all) out[value] = found.get(value) || 0;
  return out;
}

const sum = (counts) => Object.values(counts).reduce((n, c) => n + c, 0);

/**
 * @returns {Promise<{
 *   users: {byStatus: object, total: number, admins: number},
 *   listings: {byStatus: object, total: number},
 *   reservations: {byStatus: object, total: number},
 *   openReports: number
 * }>}
 */
async function platformSummary() {
  const [userStatus, admins, listingStatus, reservationStatus, openReports] = await Promise.all([
    countBy(User, "status", User.STATUSES),
    User.countDocuments({ role: "admin", status: "active" }),
    // A listing a host deleted (deletedAt set) is not counted.
    countBy(Listing, "status", Listing.STATUSES, { deletedAt: null }),
    countBy(Reservation, "status", RESERVATION_STATUSES),
    Report.countDocuments({ status: "open" }),
  ]);
  return {
    users: { byStatus: userStatus, total: sum(userStatus), admins },
    listings: { byStatus: listingStatus, total: sum(listingStatus) },
    reservations: { byStatus: reservationStatus, total: sum(reservationStatus) },
    openReports,
  };
}

module.exports = { platformSummary };
