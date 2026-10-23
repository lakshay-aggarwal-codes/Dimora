// /trips (a guest's bookings in four tabs) and /trips/:id (one booking's
// confirmation page, also readable by the booking's host and by an admin).
const Reservation = require("../models/reservation");
const { can } = require("../policies");
const { sameId } = require("../policies/shared");
const { listTrips, describeTrip } = require("../services/trips");
const reviewService = require("../services/reviews");
const { formatMoney } = require("../utils/money");
const { NotFoundError } = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

module.exports.index = async (req, res) => {
  const trips = await listTrips({}, req.user._id, {
    tab: req.query.tab,
    page: req.query.page,
    windowDays: req.app.locals.reviewWindowDays,
  });
  res.render("trips/index.ejs", { ...trips, pageTitle: "Your trips" });
};

module.exports.show = async (req, res) => {
  const { id } = req.params;
  const reservation = OBJECT_ID.test(id)
    ? await Reservation.findById(id)
        .populate(
          "listing",
          "title address location country geometry deletedAt",
        )
        .populate("host", "displayName username email")
        .populate("guest", "displayName username")
        .lean()
    : null;
  // Someone who may not see it gets the same answer as for a booking that does
  // not exist: the page never confirms that a reference is real.
  if (!reservation || !can("reservation:view", req.user, reservation)) {
    throw new NotFoundError("That booking does not exist.");
  }
  const viewerRole = sameId(reservation.guest, req.user._id)
    ? "guest"
    : sameId(reservation.host, req.user._id)
      ? "host"
      : "admin";
  // The review form, the review itself, or why there is none (P12-T02).
  const review =
    viewerRole === "guest"
      ? await reviewService.stateFor({
          user: req.user,
          reservation,
          windowDays: req.app.locals.reviewWindowDays,
        })
      : { state: "none" };
  const trip = describeTrip(reservation, { viewerRole, formatMoney, review });
  res.set("Cache-Control", "no-store"); // contains contact details and an address
  res.render("trips/show.ejs", {
    trip,
    pageTitle: `Booking ${trip.reference}`,
  });
};
