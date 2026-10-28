const { ValidationError } = require("../utils/errors");
const {
  listingSchema,
  reviewSchema,
  reviewEditSchema,
  reviewReplySchema,
} = require("../validation");

// Authentication guards live in ./auth, object-level authorization (who may
// edit/delete what) in ./authorize and ../policies (P02-T06).
const { isLoggedIn, saveRedirectUrl, requireRole } = require("./auth");
const { authorize } = require("./authorize");

module.exports.isLoggedIn = isLoggedIn;
module.exports.saveRedirectUrl = saveRedirectUrl;
module.exports.requireRole = requireRole;
module.exports.authorize = authorize;

module.exports.validateListing = (req, res, next) => {
  // `?? {}`: a request with no parsable body must fail validation, not crash.
  const { error, value } = listingSchema.validate(req.body ?? {});
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",");
    throw new ValidationError(errMsg);
  }
  req.body = value; // trimmed strings, price as a number
  next();
};

function validateWith(schema) {
  return (req, res, next) => {
    // `?? {}`: a request with no parsable body must fail validation, not crash.
    const { error } = schema.validate(req.body ?? {});
    if (error) {
      throw new ValidationError(
        error.details.map((el) => el.message).join(","),
      );
    }
    next();
  };
}

module.exports.validateReviewEdit = validateWith(reviewEditSchema);
module.exports.validateReviewReply = validateWith(reviewReplySchema);

module.exports.validateReview = (req, res, next) => {
  let { error } = reviewSchema.validate(req.body);
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",");
    throw new ValidationError(errMsg);
  } else next();
};
