// Email preferences (P11-T05). The services decide; this reads the form.
//
//   GET/POST /account/notifications   the signed-in member's switches
//   GET  /email/unsubscribe/:token    page with a button (does NOT switch anything off:
//                                     a mail scanner that opens links changes nothing)
//   POST /email/unsubscribe           switches that group off, signed in or not
const prefs = require("../services/notificationEmail");

const secretOf = (req) => req.app.locals.notificationSecret;

module.exports.show = (req, res) => {
  res.set("Cache-Control", "no-store");
  res.render("account/notifications.ejs", {
    pageTitle: "Notification settings",
    groups: prefs.effectivePrefs(req.user),
    emailConfirmed: Boolean(req.user.emailVerifiedAt),
  });
};

module.exports.save = async (req, res) => {
  await prefs.savePrefs(req.user._id, req.body);
  req.flash("success", "Your notification settings are saved.");
  res.redirect("/account/notifications");
};

module.exports.showUnsubscribe = (req, res) => {
  const token = String(req.params.token);
  const parsed = prefs.readUnsubscribeToken(token, secretOf(req));
  if (!parsed) return invalid(res);
  const { GROUP_BY_KEY } = require("../config/notificationPrefs");
  res.render("account/unsubscribe.ejs", {
    pageTitle: "Stop these emails",
    token,
    group: GROUP_BY_KEY.get(parsed.group),
  });
};

module.exports.unsubscribe = async (req, res) => {
  const token = req.body && typeof req.body.token === "string" ? req.body.token : "";
  const result = await prefs.unsubscribe(token, secretOf(req));
  if (!result.ok) return invalid(res);
  req.flash("success", `You will no longer get "${result.group.label}" emails. The notifications still appear on the site.`);
  res.redirect(req.user ? "/account/notifications" : "/");
};

function invalid(res) {
  return res.status(400).render("account/unsubscribeInvalid.ejs", { pageTitle: "This link does not work" });
}
