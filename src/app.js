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
const pinoHttp = require("pino-http");
const { randomUUID } = require("node:crypto");
const { NotFoundError } = require("./utils/errors");
const { createLogger } = require("./config/logger");
const { createErrorHandler } = require("./middleware/errors");
const User = require("./models/user.js");
const { can } = require("./policies");

const listingRouter = require("./routes/listing");
const reviewRouter = require("./routes/review");
const useRouter = require("./routes/user");
const pagesRouter = require("./routes/pages");
const {
  assignCspNonce,
  securityHeaders,
  createAuthLimiters,
} = require("./middleware/security");
const { csrfProtection } = require("./middleware/csrf");

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
 * @param {object} [options.logger] pino logger (default: JSON to stdout;
 *   silent when config.isTest).
 */
function createApp({
  config = loadEnv(),
  sessionStore,
  logger = createLogger({ level: config.isTest ? "silent" : "info" }),
} = {}) {
  configureCloudinary(config.cloudinary);

  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT_DIR, "views"));

  app.disable("x-powered-by");
  // Behind one reverse proxy (Render, Railway, nginx...): needed for secure
  // cookies and for rate limiting by the real client address.
  if (config.isProduction) app.set("trust proxy", 1);

  app.engine("ejs", ejsMate);
  // Before static files so every response carries the security headers.
  app.use(assignCspNonce);
  app.use(securityHeaders({ isProduction: Boolean(config.isProduction) }));
  app.use(express.static(path.join(ROOT_DIR, "public")));

  // After static files (so assets are not logged), before everything else so
  // every other log line and error carries the request id. Only the id, method
  // and path (no query string, headers or body) are logged for a request.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: (req.url || "").split("?")[0],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (req, res, err) =>
        err || res.statusCode >= 500 ? "error" : "info",
    }),
  );

  app.use(express.urlencoded({ extended: true }));
  app.use(methodOverride("_method"));

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
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: Boolean(config.isProduction),
    },
  };

  app.use(session(sessionOptions));
  app.use(flash());

  // After the session and the urlencoded parser, before multer and every
  // router: no state-changing route can run without a valid token (P01-T10).
  app.use(csrfProtection());

  app.use(passport.initialize());
  app.use(passport.session());
  passport.use(new LocalStrategy(User.authenticate()));

  passport.serializeUser(User.serializeUser());
  passport.deserializeUser(User.deserializeUser());

  app.use((req, res, next) => {
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    // Views ask the same policies as the routes: can("listing:edit", listing).
    res.locals.can = (action, resource) => can(action, req.user, resource);
    res.locals.mapPublicToken = config.mapbox.publicToken;
    next();
  });

  const limiters = createAuthLimiters();
  app.post("/login", limiters.login);
  app.post("/signup", limiters.signup);

  app.use("/listings", listingRouter);
  app.use("/listings/:id/reviews", reviewRouter);
  app.use("/", pagesRouter);
  app.use("/", useRouter);

  app.all("/{*splat}", (req, res, next) => {
    next(new NotFoundError());
  });

  app.use(createErrorHandler({ isProduction: config.isProduction, logger }));

  return app;
}

module.exports = { createApp };
