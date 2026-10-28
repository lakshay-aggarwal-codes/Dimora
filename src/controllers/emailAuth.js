// Email confirmation and password reset (P02-T05). The services decide; this
// only reads the form, picks the page and writes the flash text.
//
//   GET  /verify-email/:token   page with a button (does NOT use the token: a
//                               mail scanner that opens links cannot burn it)
//   POST /verify-email          uses the token
//   GET  /verify-email/needed   why you are here and "send me the link again"
//   POST /verify-email/resend   signed-in members, throttled
//   GET/POST /forgot-password   always the same answer
//   GET  /reset-password/:token page with the form (does not use the token)
//   POST /reset-password        sets the password
const emailAuth = require("../services/emailAuth");
const { TOKEN_PATTERN, EmailThrottledError, peek } = require("../services/emailTokens");
const { forgotPasswordSchema, resetPasswordSchema, PASSWORD_MIN } = require("../validation");

const JOI = { abortEarly: false, stripUnknown: true, errors: { wrap: { label: false } } };
const firstMessages = (error) => [...new Set(error.details.map((d) => d.message))].join(" ");

const FORGOT_ANSWER =
  "If an account uses that address, we have sent it a link to reset the password. The link works once, for one hour.";
const SEND_FAILED = "We could not send the email just now. Please try again in a few minutes.";

function logFailure(req, err, what) {
  const log = req.app.locals.logger;
  if (log && log.error) log.error({ err: { name: err && err.name, message: err && err.message } }, what);
}

function invalidLink(res, kind) {
  return res.status(400).render("users/linkInvalid.ejs", {
    pageTitle: "This link does not work",
    kind,
  });
}

const tokenParam = (req) => (TOKEN_PATTERN.test(String(req.params.token)) ? String(req.params.token) : null);

// ---- confirm the address ----------------------------------------------------

module.exports.showVerify = async (req, res) => {
  const raw = tokenParam(req);
  const token = raw && (await peek({ raw, purpose: "verify_email" }));
  if (!token) return invalidLink(res, "verify");
  res.render("users/verifyEmail.ejs", { pageTitle: "Confirm your email", token: raw });
};

module.exports.verify = async (req, res) => {
  const raw = req.body && typeof req.body.token === "string" ? req.body.token : "";
  const result = await emailAuth.verifyEmail({ raw });
  if (!result.ok) return invalidLink(res, "verify");
  req.flash("success", "Your email address is confirmed. You can publish listings and book stays.");
  res.redirect(req.user ? "/account" : "/login");
};

module.exports.showNeeded = (req, res) => {
  if (req.user.emailVerifiedAt) {
    req.flash("success", "Your email address is already confirmed.");
    return res.redirect("/account");
  }
  res.render("users/verifyNeeded.ejs", {
    pageTitle: "Confirm your email",
    email: req.user.email,
  });
};

module.exports.resend = async (req, res) => {
  try {
    const result = await emailAuth.sendVerification({
      user: req.user,
      emailService: req.app.locals.emailService,
      baseUrl: req.app.locals.appBaseUrl,
    });
    req.flash(
      "success",
      result.status === "already_verified"
        ? "Your email address is already confirmed."
        : `We sent a confirmation link to ${req.user.email}. It is valid for 24 hours.`,
    );
  } catch (err) {
    if (err instanceof EmailThrottledError) req.flash("error", err.message);
    else {
      logFailure(req, err, "verification email failed");
      req.flash("error", SEND_FAILED);
    }
  }
  res.redirect("/verify-email/needed");
};

// ---- forgot / reset password -------------------------------------------------

module.exports.showForgot = (req, res) => {
  res.render("users/forgot.ejs", {
    pageTitle: "Forgot your password",
    pageDescription: "Ask for a link to choose a new Dimora password.",
  });
};

module.exports.forgot = async (req, res) => {
  const { error, value } = forgotPasswordSchema.validate(req.body ?? {}, JOI);
  if (error) {
    req.flash("error", firstMessages(error));
    return res.redirect("/forgot-password");
  }
  try {
    await emailAuth.requestPasswordReset({
      email: value.email,
      emailService: req.app.locals.emailService,
      baseUrl: req.app.locals.appBaseUrl,
    });
  } catch (err) {
    // Throttled, or the provider failed: the visitor still gets the same answer,
    // so the form cannot be used to find out which addresses have accounts.
    if (!(err instanceof EmailThrottledError)) logFailure(req, err, "password reset email failed");
  }
  req.flash("success", FORGOT_ANSWER);
  res.redirect("/login");
};

module.exports.showReset = async (req, res) => {
  const raw = tokenParam(req);
  const user = raw && (await emailAuth.userForResetToken({ raw }));
  if (!user) return invalidLink(res, "reset");
  res.render("users/reset.ejs", { pageTitle: "Choose a new password", token: raw, passwordMin: PASSWORD_MIN });
};

module.exports.reset = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const raw = typeof body.token === "string" && TOKEN_PATTERN.test(body.token) ? body.token : null;
  const user = raw && (await emailAuth.userForResetToken({ raw }));
  if (!user) return invalidLink(res, "reset");

  const { error, value } = resetPasswordSchema.validate(body, {
    ...JOI,
    context: { username: user.username, email: user.email },
  });
  if (error) {
    // The token is not used up by a form that did not pass the rules.
    req.flash("error", firstMessages(error));
    return res.redirect(`/reset-password/${raw}`);
  }
  const result = await emailAuth.resetPassword({
    raw,
    newPassword: value.newPassword,
    emailService: req.app.locals.emailService,
  });
  if (!result.ok) return invalidLink(res, "reset");
  req.flash("success", "Your password was changed. Log in with the new password.");
  res.redirect("/login");
};
