// /account: change password and delete the account (P02-T04).
const accountService = require("../services/account");
const { changePasswordSchema, deleteAccountSchema } = require("../validation");

const JOI = {
  abortEarly: false,
  stripUnknown: true,
  errors: { wrap: { label: false } },
};

/** One flash entry: the layout prints an array joined by bare commas. */
function firstMessages(error) {
  return [...new Set(error.details.map((d) => d.message))].join(" ");
}

module.exports.show = async (req, res) => {
  const blockers = await accountService.deletionBlockers(req.user);
  res.render("account/index.ejs", {
    pageTitle: "Account settings",
    blockers,
    passwordMin: require("../validation").PASSWORD_MIN,
  });
};

module.exports.changePassword = async (req, res, next) => {
  const { error, value } = changePasswordSchema.validate(req.body ?? {}, {
    ...JOI,
    context: { username: req.user.username, email: req.user.email },
  });
  if (error) {
    req.flash("error", firstMessages(error));
    return res.redirect("/account");
  }
  try {
    await accountService.changePassword({
      user: req.user,
      currentPassword: value.currentPassword,
      newPassword: value.newPassword,
    });
  } catch (err) {
    if (err instanceof accountService.AccountRefusal) {
      req.flash("error", err.message);
      return res.redirect("/account");
    }
    return next(err);
  }
  // Log in again: passport starts a new session, so the id used before the
  // change cannot be reused.
  req.logIn(req.user, (loginErr) => {
    if (loginErr) return next(loginErr);
    req.flash("success", "Your password was changed.");
    res.redirect("/account");
  });
};

module.exports.deleteAccount = async (req, res, next) => {
  const { error, value } = deleteAccountSchema.validate(req.body ?? {}, JOI);
  if (error) {
    req.flash("error", firstMessages(error));
    return res.redirect("/account");
  }
  try {
    await accountService.deleteAccount({
      user: req.user,
      password: value.password,
    });
  } catch (err) {
    if (err instanceof accountService.AccountRefusal) {
      const lines = err.blockers
        ? err.blockers.map((b) => b.message).join(" ")
        : "";
      req.flash("error", lines ? `${err.message} ${lines}` : err.message);
      return res.redirect("/account");
    }
    return next(err);
  }
  req.logout((logoutErr) => {
    if (logoutErr) return next(logoutErr);
    req.flash("success", "Your account was deleted.");
    res.redirect("/");
  });
};
