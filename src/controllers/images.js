// Photo management for a listing the signed-in user may edit (the routes run
// authorize("listing:edit") first, which leaves the listing on req.listing).
// Every action is a plain form post that redirects back to the photo section of
// the edit page with a message, so it works without JavaScript.
const images = require("../services/images");
const { AppError, NotFoundError, ValidationError } = require("../utils/errors");

// The listing wizard's photo step uses the same actions and asks to come back
// to itself with ?wizard=1 (a fixed target, never a URL taken from the request).
const backTo = (req) =>
  req.query && req.query.wizard === "1"
    ? `/host/listings/${req.params.id}/steps/4`
    : `/listings/${req.params.id}/edit#photos`;

// Problems the host can fix (a bad file, a full gallery, a failed upload) come
// back to the form as a message; anything else is a real error.
async function respond(req, res, action) {
  try {
    const message = await action();
    req.flash("success", message);
  } catch (err) {
    const explainable =
      err instanceof ValidationError ||
      err instanceof NotFoundError ||
      err instanceof images.UploadFailedError;
    if (!explainable) throw err;
    if (req.log && err instanceof AppError && err.statusCode >= 500) {
      req.log.warn({ err }, "photo action failed");
    }
    req.flash("error", err.message);
  }
  res.redirect(backTo(req));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

module.exports.upload = (req, res) =>
  respond(req, res, async () => {
    const added = await images.addImages(req.listing, req.files || [], {
      log: req.log,
    });
    return `${plural(added.length, "photo")} added.`;
  });

module.exports.reorder = (req, res) =>
  respond(req, res, async () => {
    const order = [].concat((req.body && req.body.order) ?? []);
    await images.reorderImages(req.listing, order);
    return "Photo order saved.";
  });

module.exports.move = (req, res) =>
  respond(req, res, async () => {
    await images.moveImage(
      req.listing,
      req.params.imageId,
      req.body && req.body.direction,
    );
    return "Photo moved.";
  });

module.exports.makeCover = (req, res) =>
  respond(req, res, async () => {
    await images.setCover(req.listing, req.params.imageId);
    return "Cover photo changed.";
  });

module.exports.updateText = (req, res) =>
  respond(req, res, async () => {
    const body = req.body || {};
    await images.updateImageText(req.listing, req.params.imageId, {
      alt: body.alt,
      caption: body.caption,
    });
    return "Photo details saved.";
  });

module.exports.remove = (req, res) =>
  respond(req, res, async () => {
    await images.removeImage(req.listing, req.params.imageId, { log: req.log });
    return "Photo removed.";
  });
