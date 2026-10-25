// authorize("listing:edit"): loads the resource, then asks the policy.
//
//   anonymous            -> login page (same as isLoggedIn)
//   resource missing     -> 404
//   policy says no       -> 403 (or 404 with { concealForbidden: true }, for
//                           private resources, so their existence is not leaked)
//   policy says yes      -> the resource is left on req.<type> (req.listing,
//                           req.review) and the request continues
//
// Actions without a loader (listing:create, review:create) have no resource.
const Listing = require("../models/listing.js");
const Review = require("../models/review.js");
const { can } = require("../policies");
const { sameId } = require("../policies/shared");
const { ForbiddenError, NotFoundError } = require("../utils/errors");
const { redirectToLogin } = require("./auth");

const LOADERS = {
  listing: async (req) => Listing.findById(req.params.id),

  // The review must belong to the listing in the URL, otherwise
  // /listings/<any>/reviews/<id> would reach a review of another listing.
  review: async (req) => {
    const { id, reviewId } = req.params;
    const listing = await Listing.findById(id);
    if (!listing) return null;
    const belongs = (listing.reviews || []).some((r) => sameId(r, reviewId));
    if (!belongs) return null;
    return Review.findById(reviewId);
  },
};

const NOT_FOUND = {
  listing: "That listing does not exist.",
  review: "That review does not exist.",
};

const FORBIDDEN = {
  "listing:create": "You are not allowed to create listings.",
  "listing:edit": "Only the host can edit this listing.",
  "listing:delete": "Only the host can delete this listing.",
  "review:create": "You are not allowed to write reviews.",
  "review:delete": "Only the author can delete this review.",
};

function authorize(action, { concealForbidden = false } = {}) {
  // Fails at startup (route definition) for a typo, not on the first request.
  can(action, undefined, undefined);
  const type = action.split(":")[0];
  const load = action.endsWith(":create") ? null : LOADERS[type];

  const authorizeMiddleware = async (req, res, next) => {
    if (!req.user) return redirectToLogin(req, res);

    let resource;
    if (load) {
      resource = await load(req);
      if (!resource) throw new NotFoundError(NOT_FOUND[type]);
    }

    if (!can(action, req.user, resource)) {
      if (concealForbidden) throw new NotFoundError(NOT_FOUND[type]);
      throw new ForbiddenError(FORBIDDEN[action]);
    }

    if (resource) req[type] = resource;
    next();
  };
  // Lets the route matrix test (P17-T01) see which action guards a route.
  authorizeMiddleware.policyAction = action;
  return authorizeMiddleware;
}

module.exports = { authorize };
