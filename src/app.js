const path = require("node:path");
const express = require("express");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const flash = require("connect-flash");
const passport = require("passport");
const LocalStrategy = require("passport-local");

const { loadEnv } = require("./config/env");
const { configureCloudinary } = require("./config/cloudinary");
const ExpressError = require("./utils/ExpressError");
const User = require("./models/user.js");

const listingRouter = require("./routes/listing");
const reviewRouter = require("./routes/review");
const useRouter = require("./routes/user");

const ROOT_DIR = path.join(__dirname, "..");

/**
 * Builds the Express application. Requiring this file has no side effects:
 * nothing connects to MongoDB, nothing listens on a port, and no environment
 * is read until createApp() runs. server.js connects the database and listens.
 *
 * @param {object} [options]
 * @param {object} [options.config] Validated config from src/config/env.js
 *   (default: loadEnv(), which reads process.env and throws if it is invalid).
 * @param {object} [options.sessionStore] express-session store. Default: a
 *   MongoStore on config.mongodbUri. Tests pass a MemoryStore so no database
 *   is needed.
 */
function createApp({ config = loadEnv(), sessionStore } = {}) {
  configureCloudinary(config.cloudinary);

  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT_DIR, "views"));

  app.use(express.urlencoded({ extended: true }));
  app.use(methodOverride("_method"));

  app.engine("ejs", ejsMate);
  app.use(express.static(path.join(ROOT_DIR, "public")));

  let store = sessionStore;
  if (!store) {
    store = MongoStore.create({
      mongoUrl: config.mongodbUri,
      touchAfter: 24 * 60 * 60,
    });

    store.on("error", (err) => {
      console.error("Error in Mongo session store:", err);
    });
  }

  const sessionOptions = {
    store,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
    },
  };

  app.use(session(sessionOptions));
  app.use(flash());

  app.use(passport.initialize());
  app.use(passport.session());
  passport.use(new LocalStrategy(User.authenticate()));

  passport.serializeUser(User.serializeUser());
  passport.deserializeUser(User.deserializeUser());

  app.use((req, res, next) => {
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    res.locals.mapPublicToken = config.mapbox.publicToken;
    next();
  });

  app.use("/listings", listingRouter);
  app.use("/listings/:id/reviews", reviewRouter);
  app.use("/", useRouter);

  app.all("/{*splat}", (req, res, next) => {
    next(new ExpressError(404, "Page Not Found"));
  });

  // Express recognises an error handler by its four arguments, so `next` must stay.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let { statusCode = 500 } = err;
    res.status(statusCode).render("error.ejs", { err });
  });

  return app;
}

module.exports = { createApp };
