const mongoose = require("mongoose");
const passport = require("passport");
const User = require("../models/user");
const { signupSchema } = require("../validation");
const { safeRedirectPath } = require("../utils/safeRedirect");

// What the visitor is told. None of this text comes from the database driver,
// passport or Mongoose.
const MESSAGES = Object.freeze({
  // Same text for an unknown user, a wrong password, a locked account and a
  // deleted account, so the form cannot be used to find out which usernames exist.
  loginFailed:
    "Incorrect username or password. After several failed attempts an account is locked for a while.",
  suspended:
    "This account is suspended. Contact support if you think this is a mistake.",
  usernameTaken: "That username is already taken. Choose another one.",
  // Does not say which of the two was the problem: a taken email must not be
  // confirmable from the signup form.
  cannotCreate:
    "We couldn't create an account with those details. If you already have an account, log in instead.",
  signupInvalid: "Please check the details you entered and try again.",
});

// The unique index on `email` (P02-T01) rejects a second account with the same
// address with a duplicate-key error.
function isDuplicateEmailError(err) {
  if (!err || err.code !== 11000) return false;
  if (err.keyPattern && err.keyPattern.email) return true;
  return typeof err.message === "string" && err.message.includes("email");
}

function isUsernameTakenError(err) {
  return Boolean(err) && err.name === "UserExistsError";
}

function isDuplicateUsernameError(err) {
  if (!err || err.code !== 11000) return false;
  if (err.keyPattern && err.keyPattern.username) return true;
  return typeof err.message === "string" && err.message.includes("username");
}

module.exports.signup = async (req, res, next) => {
  const { error, value } = signupSchema.validate(req.body ?? {}, {
    abortEarly: false,
    // Fields the form does not have (role, status, ...) are dropped here and
    // below only username, email and password are used.
    stripUnknown: true,
    errors: { wrap: { label: false } },
  });
  if (error) {
    // Joi messages for this schema are our own text (see validation/index.js).
    // One flash entry: the layout prints the array joined by bare commas.
    const messages = [...new Set(error.details.map((d) => d.message))];
    req.flash("error", messages.join(" "));
    return res.redirect("/signup");
  }

  try {
    const { username, email, password } = value;
    const registeredUser = await User.register(
      new User({ email, username }),
      password,
    );
    req.login(registeredUser, (err) => {
      if (err) {
        return next(err);
      }
      req.flash("success", "User registered successfully");
      res.redirect("/listings");
    });
  } catch (e) {
    if (isUsernameTakenError(e) || isDuplicateUsernameError(e)) {
      req.flash("error", MESSAGES.usernameTaken);
    } else if (isDuplicateEmailError(e)) {
      req.flash("error", MESSAGES.cannotCreate);
    } else if (e instanceof mongoose.Error.ValidationError) {
      req.flash("error", MESSAGES.signupInvalid);
    } else {
      // Unexpected (database down, ...): the error page, with the real error
      // in the log only.
      return next(e);
    }
    res.redirect("/signup");
  }
};

module.exports.renderSignupForm = (req, res) => {
  res.render("./users/signup.ejs", {
    pageTitle: "Sign up",
    pageDescription: "Create a Dimora account to book stays or list your home.",
  });
};
module.exports.renderLoginForm = (req, res) => {
  res.render("./users/login.ejs", {
    pageTitle: "Log in",
    pageDescription: "Log in to your Dimora account.",
    next: safeRedirectPath(req.query && req.query.next, ""),
  });
};

function failLogin(req, res, message) {
  req.flash("error", message);
  return res.redirect("/login");
}

// passport.authenticate with a callback instead of failureRedirect/failureFlash:
// the failure text is ours (never passport's or the plugin's), and the account
// status is checked after the password so a stranger learns nothing from it.
module.exports.login = (req, res, next) => {
  passport.authenticate("local", (err, user) => {
    if (err) return next(err);
    if (!user) return failLogin(req, res, MESSAGES.loginFailed);
    if (user.status === "deleted") {
      return failLogin(req, res, MESSAGES.loginFailed);
    }
    if (user.status === "suspended") {
      return failLogin(req, res, MESSAGES.suspended);
    }
    // req.logIn starts a new session (passport 0.7), so a session id set before
    // login cannot be reused afterwards (session fixation).
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      req.flash("success", "Welcome back to Dimora ,You are logged in");
      res.redirect(res.locals.redirectUrl || "/listings");
    });
  })(req, res, next);
};

module.exports.logout = (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.flash("success", "You are logged out");
    res.redirect("/listings");
  });
};

module.exports.MESSAGES = MESSAGES;
