// The simulated payment step (P16-T01): GET/POST /trips/:id/pay.
//
// A booking made while simulated payments are on waits here, `awaiting_payment`,
// with its nights held for a short time. The page asks for NO card data at all:
// a hidden idempotency key, the optional developer outcome selector, and a
// "Pay (simulated)" button, under a "TEST MODE: no money moves" banner.
//
// Only the booking's guest may use it; anyone else gets the same 404 as for a
// booking that does not exist. What happens on a click is services/payments.js.
const crypto = require("node:crypto");
const Reservation = require("../models/reservation");
const payments = require("../services/payments");
const { sameId } = require("../policies/shared");
const { formatMoney } = require("../utils/money");
const {
  referenceOf,
  formatStayDate,
  formatInstant,
} = require("../services/trips");
const {
  NotFoundError,
  ConflictError,
  ValidationError,
} = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const OUTCOMES = Object.freeze(["success", "declined", "error"]);
const newKey = () => crypto.randomBytes(16).toString("hex"); // 32 hex characters

const tripPath = (id) => `/trips/${id}`;
const payPath = (id) => `/trips/${id}/pay`;

async function loadOwn(req) {
  const { id } = req.params;
  const reservation = OBJECT_ID.test(id) ? await Reservation.findById(id) : null;
  if (!reservation || !sameId(reservation.guest, req.user._id)) {
    throw new NotFoundError("That booking does not exist.");
  }
  return reservation;
}

const holdLabel = (reservation) =>
  formatInstant(
    reservation.holdExpiresAt,
    reservation.listingSnapshot && reservation.listingSnapshot.timezone,
  );

module.exports.show = async (req, res) => {
  const reservation = await loadOwn(req);
  // Paid already, expired, cancelled...: the booking page says where it stands.
  if (reservation.status !== "awaiting_payment") {
    return res.redirect(tripPath(reservation._id));
  }
  const now = new Date();
  if (!reservation.holdExpiresAt || reservation.holdExpiresAt.getTime() <= now.getTime()) {
    req.flash("error", "The time to pay for this booking has run out. The dates are being released.");
    return res.redirect(tripPath(reservation._id));
  }
  const snap = reservation.listingSnapshot || {};
  const price = reservation.pricingSnapshot || {};
  const settings = req.app.locals.payments || {};
  const view = {
    id: String(reservation._id),
    reference: referenceOf(reservation),
    listingTitle: snap.title || "A place on Dimora",
    city: snap.city || "",
    checkIn: formatStayDate(reservation.checkIn),
    checkOut: formatStayDate(reservation.checkOut),
    nights: reservation.nights,
    guests: reservation.guests,
    amountText: formatMoney(price.totalMinor, price.currency || "INR"),
    holdUntil: holdLabel(reservation),
    minutesLeft: Math.max(
      1,
      Math.ceil((reservation.holdExpiresAt.getTime() - now.getTime()) / 60000),
    ),
    instant: Boolean(snap.instantBook),
    idempotencyKey: newKey(),
    outcomeSelector: Boolean(settings.outcomeSelector),
    tripUrl: tripPath(reservation._id),
  };
  res.set("Cache-Control", "no-store");
  return res.render("payments/pay.ejs", {
    pay: view,
    pageTitle: `Pay for booking ${view.reference} (simulated)`,
    pageDescription: "A simulated payment step. No money moves and no card details are asked for.",
  });
};

module.exports.submit = async (req, res) => {
  const reservation = await loadOwn(req);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const settings = req.app.locals.payments || {};
  // The developer selector is honoured only when it is switched on; otherwise
  // whatever the browser sends is ignored and the payment succeeds.
  const outcome =
    settings.outcomeSelector && OUTCOMES.includes(body.outcome) ? body.outcome : "success";

  let result;
  try {
    result = await payments.pay({
      reservationId: reservation._id,
      guest: req.user,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      outcome,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(tripPath(reservation._id));
    }
    if (err instanceof ValidationError) {
      req.flash("error", "The payment page was out of date. Please try again.");
      return res.redirect(payPath(reservation._id));
    }
    throw err;
  }

  const reference = referenceOf(reservation);
  if (result.ok) {
    const instant = Boolean(reservation.listingSnapshot && reservation.listingSnapshot.instantBook);
    req.flash(
      "success",
      instant
        ? `Payment received (simulated: no money moved). You are booked. Your reference is ${reference}.`
        : `Payment received (simulated: no money moved). Your request was sent to the host, who has 24 hours to answer. Your reference is ${reference}.`,
    );
    return res.redirect(tripPath(reservation._id));
  }
  if (result.failureCode === "hold_expired") {
    req.flash("error", `${result.message} Nothing was charged and the dates are being released.`);
    return res.redirect(tripPath(reservation._id));
  }
  if (result.status === "failed") {
    req.flash(
      "error",
      `${result.message} Nothing was charged. Your dates stay held until ${holdLabel(reservation)}; you can try again.`,
    );
  } else {
    req.flash("error", result.message || "A payment for this booking is already being processed.");
  }
  return res.redirect(payPath(reservation._id));
};
