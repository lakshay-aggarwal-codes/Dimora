// The notification bell and inbox (P11-T01). Every handler works on the
// signed-in member's own notifications only (the service filters on the user);
// nothing here takes a user id from the request.
const notifications = require("../services/notifications");
const { AppError } = require("../utils/errors");

/** GET /api/notifications/count -> { unread: n } (401 JSON when signed out). */
module.exports.count = async (req, res) => {
  if (!req.user) {
    throw new AppError(401, "Please log in.", { code: "unauthenticated" });
  }
  const unread = await notifications.countUnread(req.user._id);
  res.set("Cache-Control", "no-store");
  res.json({ unread });
};

/** GET /notifications?show=unread&page=2 */
module.exports.index = async (req, res) => {
  const list = await notifications.listFor(req.user._id, {
    show: typeof req.query.show === "string" ? req.query.show : undefined,
    page: typeof req.query.page === "string" ? req.query.page : undefined,
  });
  res.set("Cache-Control", "no-store");
  res.render("notifications/index.ejs", {
    ...list,
    pageTitle: "Notifications",
    pageDescription: "Messages about your bookings and listings.",
  });
};

// Back to the list the member was on (same show/page), never to a URL taken
// from the request.
function backToList(req) {
  const params = new URLSearchParams();
  const show = req.body && req.body.show;
  const page = req.body && req.body.page;
  if (show === "unread") params.set("show", "unread");
  if (typeof page === "string" && /^[2-9]\d{0,5}$|^1\d{1,5}$/.test(page)) {
    params.set("page", page);
  }
  const qs = params.toString();
  return `/notifications${qs ? `?${qs}` : ""}`;
}

/** POST /notifications/:id/read */
module.exports.markRead = async (req, res) => {
  await notifications.markRead(req.user._id, req.params.id);
  res.redirect(backToList(req));
};

/** POST /notifications/read-all */
module.exports.markAllRead = async (req, res) => {
  const { updated } = await notifications.markAllRead(req.user._id);
  if (updated > 0) req.flash("success", "All notifications marked as read.");
  res.redirect(backToList(req));
};
