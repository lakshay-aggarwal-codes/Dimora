// Puts `savedIds` (a Set of listing ids the signed-in member has saved) in
// res.locals so the heart on a card or detail page shows the right state.
// The heart is a convenience: if the lookup fails the page still renders, with
// every heart empty, and the failure is logged.
const mongoose = require("mongoose");
const { savedIdsFor } = require("../services/wishlists");

async function withSavedIds(req, res, next) {
  res.locals.savedIds = new Set();
  // No database connection (a unit test, or the database is down): skip the
  // lookup instead of waiting for it to time out.
  if (!req.user || mongoose.connection.readyState !== 1) return next();
  try {
    res.locals.savedIds = await savedIdsFor(req.user._id);
  } catch (err) {
    if (req.log) req.log.warn({ err }, "could not load saved stays");
  }
  next();
}

module.exports = { withSavedIds };
