// Editing a listing section by section (P04-T04): /listings/:id/edit shows the
// same forms as the wizard, each saved on its own. The address is special: a
// changed address is looked up first and only saved after the host confirms the
// match. Validation is the wizard's (src/validation/wizard.js), so a published
// listing can never be edited into something the wizard would have refused.
const wizard = require("../services/wizard");
const { galleryOf, MAX_IMAGES } = require("../services/images");
const {
  lookupAddress,
  LocationNotFoundError,
  GeocoderUnavailableError,
} = require("../services/geocoding");
const { rememberLookup, takeLookup } = require("../services/locationConfirm");
const { validateStep } = require("../validation/wizard");
const { NotFoundError } = require("../utils/errors");
const {
  PROPERTY_TYPES,
  ROOM_TYPES,
  CANCELLATION_POLICIES,
  AMENITIES,
} = require("../config/constants");

// URL key -> wizard step number. Photos have their own routes.
const SECTIONS = Object.freeze({ basics: 1, location: 2, details: 3, pricing: 5 });
const LISTS = { PROPERTY_TYPES, ROOM_TYPES, CANCELLATION_POLICIES, AMENITIES };

const editUrl = (listing, key) => `/listings/${listing._id}/edit${key ? `#${key}` : ""}`;

/** The edit page. `failed` = { key, values, errors, formError } for a section that was refused. */
function renderEdit(res, listing, { failed, status = 200 } = {}) {
  const values = {};
  const errors = {};
  for (const [key, step] of Object.entries(SECTIONS)) {
    const own = failed && failed.key === key;
    values[key] = own && failed.values ? failed.values : wizard.formValues(listing, step);
    errors[key] = own && failed.errors ? failed.errors : {};
  }
  res.status(status).render("listings/edit.ejs", {
    listing,
    values,
    errors,
    formError: failed && failed.formError,
    failedKey: failed && failed.key,
    lists: LISTS,
    gallery: galleryOf(listing),
    maxImages: MAX_IMAGES,
    pageTitle: `Edit ${listing.title}`,
    pageDescription: "Change the details of your listing.",
  });
}

module.exports.renderEdit = renderEdit;
module.exports.SECTIONS = SECTIONS;

module.exports.renderEditForm = (req, res) => {
  // A listing still being written belongs in the wizard.
  if (req.listing.status === "draft") {
    return res.redirect(`/host/listings/${req.listing._id}`);
  }
  renderEdit(res, req.listing);
};

module.exports.save = async (req, res) => {
  const listing = req.listing; // loaded by authorize("listing:edit")
  const key = req.params.key;
  if (!Object.hasOwn(SECTIONS, key)) {
    throw new NotFoundError("That part of the listing does not exist.");
  }
  if (listing.status === "draft") {
    return res.redirect(`/host/listings/${listing._id}`);
  }
  const step = SECTIONS[key];

  // `confirmed` belongs to the location confirmation form, not to the address.
  const { confirmed, ...body } = req.body ?? {};
  const { value, errors } = validateStep(step, body);
  if (!value) {
    return renderEdit(res, listing, {
      failed: { key, values: body, errors },
      status: 400,
    });
  }

  let geometry;
  if (step === 2 && wizard.addressChanged(listing, value)) {
    const pending = confirmed === "on" ? takeLookup(req.session, listing._id, value) : null;
    if (pending) {
      geometry = pending.geometry;
    } else {
      let found;
      try {
        found = await lookupAddress({
          location: wizard.addressQuery(value),
          country: value.country,
        });
      } catch (err) {
        if (err instanceof LocationNotFoundError) {
          return renderEdit(res, listing, {
            failed: { key, values: body, errors: { line1: err.message } },
            status: 400,
          });
        }
        if (err instanceof GeocoderUnavailableError) {
          if (req.log) req.log.warn({ err }, "geocoding failed");
          return renderEdit(res, listing, {
            failed: { key, values: body, formError: err.message },
            status: 503,
          });
        }
        throw err;
      }
      rememberLookup(req.session, listing._id, value, found);
      return res.render("listings/confirm-location.ejs", {
        listing,
        address: value,
        placeName: found.placeName,
        pageTitle: "Confirm the location",
        pageDescription: "Check that we found the right place.",
      });
    }
  }

  wizard.applyStep(listing, step, value, { geometry });
  await listing.save();
  req.flash("success", "Changes saved.");
  res.redirect(editUrl(listing, key));
};
