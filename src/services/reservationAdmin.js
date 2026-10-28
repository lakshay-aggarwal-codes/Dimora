// Reservation lookup for admins (P14-T05). READ-ONLY: nothing here changes a
// reservation (an admin who must act on a booking does it through the
// listing or account tools, which are audited). Search text is matched as
// plain text, never as a pattern.
const mongoose = require("mongoose");
const Reservation = require("../models/reservation");
const User = require("../models/user");
const Listing = require("../models/listing");
const { STATUSES } = require("./stateMachine");
const { toPageNumber } = require("./audit");

const PAGE_SIZE = 20;
const QUERY_MAX = 100;
// How many guests / listings one text search may widen to. Past this the page
// says so and asks for a narrower search instead of building a huge $in.
const LOOKUP_CAP = 50;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isId = (value) => typeof value === "string" && mongoose.isValidObjectId(value) && /^[a-f0-9]{24}$/i.test(value);

/**
 * Reservations matching `q` and/or one status, newest first.
 *  - `q` that is a 24-character id: that reservation, or every reservation of
 *    that guest, host or listing;
 *  - any other `q`: guests by username / email / display name, and listings by
 *    title (case-insensitive, plain text).
 * @returns {{rows: object[], page: number, totalPages: number, total: number, q: string, status: string, capped: boolean}}
 */
async function searchReservations({ q, status, page } = {}) {
  const text = typeof q === "string" ? q.trim().slice(0, QUERY_MAX) : "";
  const filter = {};
  let capped = false;

  if (text) {
    if (isId(text)) {
      const id = new mongoose.Types.ObjectId(text);
      filter.$or = [{ _id: id }, { guest: id }, { host: id }, { listing: id }];
    } else {
      const rx = new RegExp(escapeRegex(text), "i");
      const [guests, listings] = await Promise.all([
        User.find({ $or: [{ username: rx }, { email: rx }, { displayName: rx }] })
          .select("_id")
          .limit(LOOKUP_CAP + 1)
          .lean(),
        Listing.find({ title: rx }).select("_id").limit(LOOKUP_CAP + 1).lean(),
      ]);
      capped = guests.length > LOOKUP_CAP || listings.length > LOOKUP_CAP;
      filter.$or = [
        { guest: { $in: guests.slice(0, LOOKUP_CAP).map((u) => u._id) } },
        { listing: { $in: listings.slice(0, LOOKUP_CAP).map((l) => l._id) } },
      ];
    }
  }
  const wanted = typeof status === "string" && STATUSES.includes(status) ? status : "";
  if (wanted) filter.status = wanted;

  const total = await Reservation.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(toPageNumber(page), totalPages);
  const rows = await Reservation.find(filter)
    .select("listing guest host checkIn checkOut nights guests status pricingSnapshot.totalMinor pricingSnapshot.currency listingSnapshot.title createdAt")
    .sort({ createdAt: -1, _id: -1 })
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .populate("guest", "username")
    .populate("host", "username")
    .populate("listing", "title")
    .lean();
  return { rows, page: current, totalPages, total, q: text, status: wanted, capped };
}

/** One reservation with its people and listing, or null for a malformed or unknown id. */
async function getReservation(id) {
  if (!isId(id)) return null;
  return Reservation.findById(id)
    .populate("guest", "username displayName email status")
    .populate("host", "username displayName email status")
    .populate("listing", "title status deletedAt")
    .lean();
}

module.exports = { searchReservations, getReservation, PAGE_SIZE, LOOKUP_CAP };
