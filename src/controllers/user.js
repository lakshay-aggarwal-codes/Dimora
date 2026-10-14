const User = require("../models/user");

// The unique index on `email` (P02-T01) rejects a second account with the same
// address with a duplicate-key error. Show a plain message, never the driver's.
function isDuplicateEmailError(err) {
  if (!err || err.code !== 11000) return false;
  if (err.keyPattern && err.keyPattern.email) return true;
  return typeof err.message === "string" && err.message.includes("email");
}

module.exports.signup = async (req, res, next) => {
  try {
    let { username, email, password } = req.body;
    const newUser = new User({ email, username });
    const registeredUser = await User.register(newUser, password);
    req.login(registeredUser, (err) => {
      if (err) {
        return next(err);
      }
      req.flash("success", "User registered successfully");
      res.redirect("/listings");
    });
  } catch (e) {
    req.flash(
      "error",
      isDuplicateEmailError(e)
        ? "An account with that email address already exists."
        : e.message,
    );
    res.redirect("/signup");
  }
};

module.exports.renderSignupForm = (req, res) => {
  res.render("./users/signup.ejs");
};
module.exports.renderLoginForm = (req, res) => {
  res.render("./users/login.ejs");
};

module.exports.login = async (req, res) => {
  req.flash("success", "Welcome back to Dimora ,You are logged in");
  res.redirect(res.locals.redirectUrl || "/listings");
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
