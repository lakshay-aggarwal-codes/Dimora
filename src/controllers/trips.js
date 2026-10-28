// /trips (a guest's bookings in four tabs) and /trips/:id (one booking's
// confirmation page, also readable by the booking's host and by an admin).
const Reservation = require("../models/reservation");
const { can } = require("../policies");
const { sameId } = require("../policies/shared");
const { listTrips, describeTrip } = require("../services/trips");
const reviewService = require("../services/reviews");
const { cancelBooking } = require("../services/cancellations");
const modifications = require("../services/modifications");
const {
  lineLabel,
  referenceOf,
  formatStayDate,
  formatStayWeekday,
} = require("../services/trips");
const { formatMoney } = require("../utils/money");
const { formatDateOnly, todayIn, DEFAULT_TIMEZONE } = require("../utils/dates");
const {
  NotFoundError,
  ConflictError,
  ValidationError,
  PriceChangedError,
} = require("../utils/errors");

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

// POST /trips/:id/cancel: the guest cancels (P09-T03). A booking that changed
// under them (answered, cancelled, over) is shown again with the reason.
module.exports.cancel = async (req, res) => {
  let result;
  try {
    result = await cancelBooking(
      { logger: req.log },
      {
        id: req.params.id,
        user: req.user,
        reason: req.body ? req.body.reason : undefined,
      },
    );
  } catch (err) {
    if (err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(`/trips/${req.params.id}`);
    }
    throw err;
  }
  req.flash(
    "success",
    "Your booking is cancelled and the dates are free again. The refund below is calculated only: Dimora does not move money yet.",
  );
  return res.redirect(`/trips/${result.reservation._id}`);
};

// ---- Change the dates (P09-T04) ----------------------------------------

// A query or body value is used only when it is one plain string (never an
// array or an object made by repeated or bracketed parameters).
const plain = (value) => (typeof value === "string" ? value : undefined);

const changePath = (id, { in: checkIn, out } = {}) => {
  const q = [];
  if (checkIn) q.push(`in=${encodeURIComponent(checkIn)}`);
  if (out) q.push(`out=${encodeURIComponent(out)}`);
  return `/trips/${id}/change${q.length ? `?${q.join("&")}` : ""}`;
};

// What the change page prints. The new stay's amounts are the ones the service
// will store (the same pricing call), nothing is computed here.
function changeView(preview, extra = {}) {
  const { reservation, listing, quote } = preview;
  const snap = reservation.listingSnapshot || {};
  const tz = snap.timezone || DEFAULT_TIMEZONE;
  const price = reservation.pricingSnapshot || {};
  const currency = price.currency || "INR";
  const id = String(reservation._id);
  return {
    id,
    reference: referenceOf(reservation),
    title: snap.title || (listing && listing.title) || "Your stay",
    reapproval: preview.reapproval,
    instantBook: Boolean(snap.instantBook),
    current: {
      inLabel: `${formatStayWeekday(reservation.checkIn)}, ${formatStayDate(reservation.checkIn)}`,
      outLabel: `${formatStayWeekday(reservation.checkOut)}, ${formatStayDate(reservation.checkOut)}`,
      inIso: formatDateOnly(reservation.checkIn),
      outIso: formatDateOnly(reservation.checkOut),
      nights: reservation.nights,
      guests: reservation.guests,
      totalText: formatMoney(price.totalMinor, currency),
    },
    form: {
      in: preview.checkIn ? formatDateOnly(preview.checkIn) : "",
      out: preview.checkOut ? formatDateOnly(preview.checkOut) : "",
    },
    minDate: formatDateOnly(todayIn(tz)),
    problems: preview.problems.map((p) => p.message),
    proposal: quote
      ? {
          inLabel: `${formatStayWeekday(preview.checkIn)}, ${formatStayDate(preview.checkIn)}`,
          outLabel: `${formatStayWeekday(preview.checkOut)}, ${formatStayDate(preview.checkOut)}`,
          nights: quote.nights,
          lines: (quote.lines || []).map((line) => ({
            label: lineLabel(line, formatMoney, quote.currency),
            amount: formatMoney(line.amountMinor, quote.currency),
            included: Boolean(line.included),
          })),
          totalText: formatMoney(quote.totalMinor, quote.currency),
          totalMinor: quote.totalMinor,
          difference: modifications.describeDifference(preview.differenceMinor, {
            formatMoney,
            currency: quote.currency,
          }),
        }
      : null,
    priceChanged: extra.previousTotalMinor
      ? { previousText: formatMoney(extra.previousTotalMinor, currency) }
      : null,
  };
}

async function renderChange(req, res, status, preview, extra) {
  res.set("Cache-Control", "no-store");
  res.status(status).render("trips/change.ejs", {
    change: changeView(preview, extra),
    pageTitle: "Change dates",
  });
}

// GET /trips/:id/change[?in=&out=]: the form, and with dates the new price and
// the difference. Changes nothing.
module.exports.changeForm = async (req, res) => {
  let preview;
  try {
    preview = await modifications.previewChange({
      id: req.params.id,
      user: req.user,
      in: plain(req.query.in),
      out: plain(req.query.out),
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(`/trips/${req.params.id}`);
    }
    throw err;
  }
  return renderChange(req, res, 200, preview);
};

// POST /trips/:id/change: applies the change the guest confirmed. The total
// they looked at travels with the form; the server compares it with its own.
module.exports.change = async (req, res) => {
  const body = req.body || {};
  const stay = { in: plain(body.in), out: plain(body.out) };
  let result;
  try {
    result = await modifications.changeDates({
      id: req.params.id,
      user: req.user,
      ...stay,
      expectedTotalMinor: plain(body.expectedTotalMinor),
    });
  } catch (err) {
    if (err instanceof PriceChangedError) {
      // Nothing changed: show the new price and ask again.
      const preview = await modifications.previewChange({
        id: req.params.id,
        user: req.user,
        ...stay,
      });
      return renderChange(req, res, 409, preview, {
        previousTotalMinor: Number(plain(body.expectedTotalMinor)) || null,
      });
    }
    if (err instanceof ConflictError && err.code === "nights_unavailable") {
      req.flash("error", "Some of those nights were just taken. Please choose other dates.");
      return res.redirect(changePath(req.params.id, stay));
    }
    if (err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(`/trips/${req.params.id}`);
    }
    if (err instanceof ValidationError && err.code !== "validation_error") {
      req.flash("error", err.message);
      return res.redirect(changePath(req.params.id, stay));
    }
    throw err;
  }
  req.flash(
    "success",
    result.reapproval
      ? "Your new dates were sent back to the host, who has 24 hours to answer. The new nights are held for you meanwhile. (Simulation: no payment was taken or returned.)"
      : "Your dates are changed. The price difference is recorded only: Dimora does not take or return money yet.",
  );
  return res.redirect(`/trips/${result.reservation._id}`);
};
