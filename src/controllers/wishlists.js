// /wishlists and the heart's POST /listings/:id/save (P10-T01).
const service = require("../services/wishlists");
const { ValidationError } = require("../utils/errors");
const { safeRedirectPath } = require("../utils/safeRedirect");

/** Where a form (no JavaScript) goes back to: the page it was sent from. */
function backPath(req, fallback) {
  try {
    const from = new URL(req.get("referer") || "");
    if (from.host === req.get("host")) {
      return safeRedirectPath(from.pathname + from.search, fallback);
    }
  } catch {
    // no or unreadable Referer: use the fallback
  }
  return fallback;
}

module.exports.index = async (req, res) => {
  const saved = await service.overview(req.user._id);
  res.set("Cache-Control", "no-store");
  res.render("wishlists/index.ejs", {
    ...saved,
    pageTitle: "Saved stays",
    pageDescription: "The stays you saved on Dimora.",
  });
};

// Body: saved=true | saved=false. The page sends the state it wants, so
// repeating a request never flips the heart back.
module.exports.save = async (req, res) => {
  const value = req.body && req.body.saved;
  if (value !== "true" && value !== "false") {
    throw new ValidationError("Say whether to save or to remove this stay.");
  }
  const result = await service.setSaved(
    req.user._id,
    req.params.id,
    value === "true",
  );
  // fetch() asks for JSON; a plain form post gets a redirect and a message.
  if (req.accepts(["html", "json"]) === "json") return res.json(result);
  req.flash(
    "success",
    result.saved ? "Saved to your saved stays." : "Removed from your saved stays.",
  );
  return res.redirect(backPath(req, `/listings/${encodeURIComponent(req.params.id)}`));
};
