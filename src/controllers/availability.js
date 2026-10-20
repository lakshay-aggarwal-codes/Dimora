// Host availability calendar (P07-T03): /host/listings/:id/calendar.
// Every route is behind authorize("listing:edit") (src/routes/host.js), so
// only the listing's host gets here and the listing is on req.listing.
const availability = require("../services/availability");
const { formatMonthKey } = require("../utils/dates");
const {
  ConflictError,
  NotFoundError,
  ValidationError,
} = require("../utils/errors");

const calendarUrl = (id, month) =>
  `/host/listings/${id}/calendar${month ? `?month=${month}` : ""}`;

// Only a live listing has guests to plan around: a draft is still being
// written and a suspended one is out of the host's hands.
function guardListing(req, res) {
  const listing = req.listing;
  if (listing.deletedAt) throw new NotFoundError("That listing does not exist.");
  if (["published", "unpublished"].includes(listing.status)) return true;
  if (listing.status === "draft") {
    req.flash(
      "error",
      "Finish and publish this listing before you manage its availability.",
    );
    res.redirect(`/host/listings/${listing._id}`);
  } else {
    req.flash("error", "This listing is suspended, so its calendar is closed.");
    res.redirect(`/host/listings/${listing._id}/status`);
  }
  return false;
}

async function renderCalendar(
  req,
  res,
  { month, status = 200, errors = {}, values = {} } = {},
) {
  const listing = req.listing;
  const calendar = await availability.monthView(listing, month);
  const { runs, truncated } = await availability.listBlocks(listing);
  res.status(status).render("host/calendar.ejs", {
    listing,
    calendar,
    runs,
    truncated,
    errors,
    values,
    noteMaxLength: availability.NOTE_MAX_LENGTH,
    pageTitle: `Availability: ${listing.title}`,
    pageDescription: "Block and unblock the nights your place is not available.",
  });
}

// The month to go back to after a change: the one that holds the first night.
function monthAfter(from, fallback) {
  return from ? formatMonthKey(from) : fallback;
}

module.exports.show = async (req, res) => {
  if (!guardListing(req, res)) return;
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  await renderCalendar(req, res, { month });
};

module.exports.block = async (req, res) => {
  if (!guardListing(req, res)) return;
  const body = req.body ?? {};
  const month = typeof body.month === "string" ? body.month : undefined;
  let result;
  try {
    result = await availability.blockDates(req.listing, body, {
      userId: req.user._id,
    });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ConflictError) {
      return renderCalendar(req, res, {
        month,
        status: err.statusCode,
        errors: { block: err.message },
        values: body,
      });
    }
    throw err;
  }
  req.flash(
    "success",
    result.changed
      ? `Blocked ${result.blocked} ${result.blocked === 1 ? "night" : "nights"}.${
          result.alreadyBlocked
            ? ` ${result.alreadyBlocked} ${result.alreadyBlocked === 1 ? "night was" : "nights were"} already blocked.`
            : ""
        }`
      : "Those nights were already blocked.",
  );
  res.redirect(calendarUrl(req.listing._id, monthAfter(result.from, month)));
};

module.exports.unblock = async (req, res) => {
  if (!guardListing(req, res)) return;
  const body = req.body ?? {};
  const month = typeof body.month === "string" ? body.month : undefined;
  let result;
  try {
    result = await availability.unblockDates(req.listing, body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return renderCalendar(req, res, {
        month,
        status: err.statusCode,
        errors: { unblock: err.message },
        values: { unblockFrom: body.from, unblockThrough: body.through },
      });
    }
    throw err;
  }
  req.flash(
    "success",
    result.released
      ? `Unblocked ${result.released} ${result.released === 1 ? "night" : "nights"}.`
      : "Nothing was blocked between those dates.",
  );
  res.redirect(calendarUrl(req.listing._id, monthAfter(result.from, month)));
};
