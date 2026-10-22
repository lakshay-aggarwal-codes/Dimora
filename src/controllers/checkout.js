// Checkout (P08-T03): GET/POST /listings/:id/checkout?in&out&guests
//
// GET  shows the stay, the rules, the cancellation terms and the final price
//      breakdown, with a hidden idempotency key and the total the guest is
//      about to confirm.
// POST sends that stay, that total and that key to reservations.create. If the
//      real price differs from the confirmed total (PriceChangedError) the page
//      is drawn again with the differences highlighted and a confirmation box
//      that must be ticked. Nothing is booked in that case.
//
// Nothing here prices anything or decides availability: quoteService (the same
// call as the quote API) and reservations.create do, so the total shown is the
// total stored.
const crypto = require("node:crypto");
const Listing = require("../models/listing");
const reservationService = require("../services/reservations");
const { getQuote } = require("../services/quoteService");
const { buildCheckoutView } = require("../services/checkout");
const { isPublic } = require("../utils/visibility");
const { isActiveUser, sameId } = require("../policies/shared");
const {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
  PriceChangedError,
} = require("../utils/errors");

const GENERIC = "validation_error";

const newKey = () => crypto.randomBytes(16).toString("hex"); // 32 hex characters

const listingPath = (id, params) => {
  const query = params ? new URLSearchParams(params).toString() : "";
  return `/listings/${id}${query ? `?${query}` : ""}`;
};

const checkoutPath = (id, stay) =>
  `/listings/${id}/checkout?${new URLSearchParams({ in: stay.in, out: stay.out, guests: stay.guests }).toString()}`;

// Where a guest lands after booking. The trips page (P09-T01) will replace it.
const confirmationPath = (reservation) => listingPath(reservation.listing);

const text = (value) => (typeof value === "string" ? value : "");

async function loadBookable(id, user) {
  const listing = await Listing.findById(id);
  if (!listing || !isPublic(listing) || !listing.owner) {
    throw new NotFoundError("That place is not available for booking.");
  }
  if (!isActiveUser(user)) {
    throw new ForbiddenError("Your account cannot make bookings.");
  }
  if (sameId(listing.owner, user._id)) {
    throw new ForbiddenError("You cannot book your own listing.");
  }
  return listing;
}

function render(res, listing, status, view) {
  res.set("Cache-Control", "no-store");
  res.status(status).render("checkout/show.ejs", {
    pageTitle: `Confirm your stay at ${listing.title}`,
    pageDescription: "Review your stay and the price before you book.",
    checkout: view,
  });
}

module.exports.show = async (req, res) => {
  const listing = await loadBookable(req.params.id, req.user);
  let payload;
  try {
    payload = await getQuote(listing, req.query);
  } catch (err) {
    if (err instanceof ValidationError && err.fields) {
      req.flash(
        "error",
        Object.values(err.fields)[0] || "Please choose your dates first.",
      );
      return res.redirect(listingPath(listing._id));
    }
    throw err;
  }
  if (!payload.bookable) {
    // e.g. the nights were taken while the guest was on the listing page.
    req.flash("error", payload.problems[0].message);
    return res.redirect(listingPath(listing._id, { guests: payload.guests }));
  }
  return render(
    res,
    listing,
    200,
    buildCheckoutView(listing, payload, { idempotencyKey: newKey() }),
  );
};

module.exports.submit = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const stay = {
    in: text(body.in),
    out: text(body.out),
    guests: text(body.guests),
  };
  const key = text(body.idempotencyKey);
  const expected = text(body.expectedTotalMinor);
  const listing = await loadBookable(req.params.id, req.user);

  // A browser that does not send the confirmed total cannot book: the server
  // would have nothing to compare the price with.
  if (!/^\d{1,15}$/.test(expected)) {
    req.flash(
      "error",
      "The booking page was out of date. Please check the details and confirm again.",
    );
    return res.redirect(listingPath(listing._id));
  }

  try {
    const { reservation } = await reservationService.create({
      guest: req.user,
      listing: listing._id,
      in: stay.in,
      out: stay.out,
      guests: stay.guests,
      expectedTotalMinor: expected,
      idempotencyKey: key,
    });
    const instant = reservation.status === "confirmed";
    const reference = String(reservation._id).slice(-8).toUpperCase();
    req.flash(
      "success",
      instant
        ? `You are booked. Your reference is ${reference}. (Simulation: no payment was taken.)`
        : `Your request was sent to the host, who has 24 hours to answer. Your reference is ${reference}. (Simulation: no payment was taken.)`,
    );
    return res.redirect(confirmationPath(reservation));
  } catch (err) {
    if (err instanceof PriceChangedError) {
      // Draw the page again with the new price; nothing was booked.
      const payload = await getQuote(listing, stay);
      if (!payload.bookable) {
        req.flash("error", payload.problems[0].message);
        return res.redirect(listingPath(listing._id));
      }
      const view = buildCheckoutView(listing, payload, {
        previousTotalMinor: Number(expected),
        previousLines: text(body.previousLines),
        idempotencyKey: key,
      });
      return render(res, listing, 409, view);
    }
    if (err instanceof ConflictError && err.code === "nights_unavailable") {
      req.flash(
        "error",
        "Some of those nights were just taken. Please choose other dates.",
      );
      return res.redirect(listingPath(listing._id, { guests: stay.guests }));
    }
    if (err instanceof ConflictError && err.code === "idempotency_key_reused") {
      req.flash("error", err.message);
      return res.redirect(checkoutPath(listing._id, stay));
    }
    // A booking rule that changed while the guest was on the page (notice,
    // same-day cut-off, stay length): its own message, back to the listing.
    if (err instanceof ValidationError && err.code && err.code !== GENERIC) {
      req.flash("error", err.message);
      return res.redirect(listingPath(listing._id));
    }
    throw err;
  }
};
