// The listing wizard (P04-T02): /host/listings/... Every step is a full-page
// form post, so it works without JavaScript; each step saves the draft, and a
// draft is invisible to the public until it is published at the end.
const crypto = require("node:crypto");
const Listing = require("../models/listing");
const wizard = require("../services/wizard");
const { galleryOf, MAX_IMAGES } = require("../services/images");
const {
  geocodeAddress,
  LocationNotFoundError,
  GeocoderUnavailableError,
} = require("../services/geocoding");
const { validateStep } = require("../validation/wizard");
const { NotFoundError, ValidationError } = require("../utils/errors");
const {
  PROPERTY_TYPES,
  ROOM_TYPES,
  CANCELLATION_POLICIES,
  AMENITIES,
} = require("../config/constants");

const TOKEN = /^[0-9a-f-]{36}$/i;
const stepUrl = (id, n) => `/host/listings/${id}/steps/${n}`;

function renderStep(res, { listing, n, values, errors = {}, status = 200, formError }) {
  const step = wizard.stepByNumber(n);
  const steps = listing
    ? wizard.stepStatuses(listing)
    : wizard.STEPS.map((item) => ({
        ...item,
        complete: false,
        reachable: item.n === 1,
      }));
  res.status(status).render("host/step.ejs", {
    listing,
    step,
    steps,
    values: values ?? (listing ? wizard.formValues(listing, n) : {}),
    errors,
    formError,
    lists: { PROPERTY_TYPES, ROOM_TYPES, CANCELLATION_POLICIES, AMENITIES },
    photoList: listing && n === 4 ? galleryOf(listing) : [],
    maxImages: MAX_IMAGES,
    draftToken: listing ? undefined : crypto.randomUUID(),
    pageTitle: `${step.title} (step ${n} of ${wizard.STEPS.length})`,
    pageDescription: "Add your place to Dimora, one short step at a time.",
  });
}

// Only a draft can be worked on here; a published listing is edited elsewhere.
function requireDraft(req, res) {
  if (req.listing.status === "draft") return true;
  req.flash("error", "This listing is already published. You can edit it here.");
  res.redirect(`/listings/${req.listing._id}/edit`);
  return false;
}

module.exports.newForm = (req, res) => renderStep(res, { n: 1 });

module.exports.create = async (req, res) => {
  const { draftToken, ...body } = req.body ?? {};
  if (draftToken !== undefined && !TOKEN.test(String(draftToken))) {
    throw new ValidationError("That form has expired. Please start again.");
  }
  const { value, errors } = validateStep(1, body);
  if (!value) {
    return renderStep(res, { n: 1, values: body, errors, status: 400 });
  }

  const draft = new Listing({
    status: "draft",
    owner: req.user._id,
    draftToken: draftToken ? String(draftToken).toLowerCase() : undefined,
  });
  wizard.applyStep(draft, 1, value);
  wizard.markStepDone(draft, 1);
  try {
    await draft.save();
  } catch (err) {
    // The same form was submitted twice: use the draft the first one made.
    if (err && err.code === 11000 && draftToken) {
      const first = await Listing.findOne({
        owner: req.user._id,
        draftToken: String(draftToken).toLowerCase(),
      });
      if (first) return res.redirect(stepUrl(first._id, 2));
    }
    throw err;
  }
  res.redirect(stepUrl(draft._id, 2));
};

// /host/listings/:id: carry on where the host left off.
module.exports.resume = (req, res) => {
  if (req.listing.status !== "draft") {
    return res.redirect(`/listings/${req.listing._id}`);
  }
  res.redirect(stepUrl(req.listing._id, wizard.firstIncompleteStep(req.listing)));
};

module.exports.showStep = (req, res) => {
  const n = wizard.parseStep(req.params.n);
  if (n === null) throw new NotFoundError("That step does not exist.");
  if (!requireDraft(req, res)) return;
  if (!wizard.canOpenStep(req.listing, n)) {
    const target = wizard.firstIncompleteStep(req.listing);
    req.flash("error", `Please finish step ${target} first.`);
    return res.redirect(stepUrl(req.listing._id, target));
  }
  renderStep(res, { listing: req.listing, n });
};

module.exports.saveStep = async (req, res) => {
  const n = wizard.parseStep(req.params.n);
  if (n === null || n === wizard.REVIEW_STEP) {
    throw new NotFoundError("That step does not exist.");
  }
  const listing = req.listing;
  if (!requireDraft(req, res)) return;
  if (!wizard.canOpenStep(listing, n)) {
    const target = wizard.firstIncompleteStep(listing);
    req.flash("error", `Please finish step ${target} first.`);
    return res.redirect(stepUrl(listing._id, target));
  }

  // The photos have their own forms; here "Continue" only checks there is one.
  if (n === 4) {
    if (galleryOf(listing).length < 1) {
      return renderStep(res, {
        listing,
        n,
        status: 400,
        formError: "Add at least one photo before you continue.",
      });
    }
    wizard.markStepDone(listing, n);
    await listing.save();
    return res.redirect(stepUrl(listing._id, n + 1));
  }

  const { value, errors } = validateStep(n, req.body);
  if (!value) {
    return renderStep(res, { listing, n, values: req.body, errors, status: 400 });
  }

  let geometry;
  if (n === 2 && wizard.addressChanged(listing, value)) {
    try {
      geometry = await geocodeAddress({
        location: wizard.addressQuery(value),
        country: value.country,
      });
    } catch (err) {
      if (err instanceof LocationNotFoundError) {
        return renderStep(res, {
          listing,
          n,
          values: req.body,
          errors: { line1: err.message },
          status: 400,
        });
      }
      if (err instanceof GeocoderUnavailableError) {
        if (req.log) req.log.warn({ err }, "geocoding failed");
        return renderStep(res, {
          listing,
          n,
          values: req.body,
          formError: err.message,
          status: 503,
        });
      }
      throw err;
    }
  }

  wizard.applyStep(listing, n, value, { geometry });
  wizard.markStepDone(listing, n);
  await listing.save();
  res.redirect(stepUrl(listing._id, n + 1));
};

// Only a draft whose five steps are all finished (and still valid) goes public.
module.exports.publish = async (req, res) => {
  const listing = req.listing;
  if (listing.status !== "draft") {
    return res.redirect(`/listings/${listing._id}`);
  }
  if (!wizard.isStepComplete(listing, wizard.REVIEW_STEP)) {
    const target = wizard.firstIncompleteStep(listing);
    req.flash("error", `Finish step ${target} before you publish.`);
    return res.redirect(stepUrl(listing._id, target));
  }
  listing.status = "published";
  await listing.save();
  req.flash("success", "Your listing is published.");
  res.redirect(`/listings/${listing._id}`);
};
