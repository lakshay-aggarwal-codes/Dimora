const mongoose = require("mongoose");
const { AppError } = require("../utils/errors");

const TITLES = {
  400: "Bad request",
  401: "Please log in",
  403: "Not allowed",
  404: "Page Not Found",
  409: "Conflict",
  413: "Upload too large",
  429: "Too many requests",
  500: "Something went wrong",
};
const GENERIC_500 = "Something went wrong on our side. Please try again.";

function titleFor(status) {
  return TITLES[status] || (status >= 500 ? TITLES[500] : "Request failed");
}

/**
 * Turns anything that was thrown into { status, message, code, expose }.
 * `message` is always safe to show to a visitor in production.
 * Handles non-Error throws (strings, objects, null).
 */
function normalizeError(err) {
  if (err instanceof AppError) {
    const status = err.statusCode;
    return {
      status,
      code: err.code,
      message: status >= 500 ? GENERIC_500 : err.message,
    };
  }
  if (err instanceof mongoose.Error.CastError) {
    // e.g. /listings/not-an-object-id
    return { status: 404, code: "not_found", message: "Page Not Found" };
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return {
      status: 400,
      code: "validation_error",
      message: "The submitted data is not valid.",
    };
  }
  if (err && typeof err === "object" && err.code === 11000) {
    return {
      status: 409,
      code: "duplicate_key",
      message: "That value is already in use.",
    };
  }
  if (err && typeof err === "object" && err.name === "MulterError") {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return {
      status: tooBig ? 413 : 400,
      code: "upload_rejected",
      message: tooBig
        ? "That image is too large (maximum 5 MB)."
        : "The upload could not be processed.",
    };
  }
  // http-errors style client errors from Express/body-parser (4xx, expose=true).
  if (
    err &&
    typeof err === "object" &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 500 &&
    err.expose === true
  ) {
    return {
      status: err.status,
      code: "client_error",
      message:
        typeof err.message === "string" ? err.message : titleFor(err.status),
    };
  }
  return { status: 500, code: "internal_error", message: GENERIC_500 };
}

function wantsJson(req) {
  const url = req.originalUrl || req.url || "";
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
    return true;
  }
  return req.accepts(["html", "json"]) === "json";
}

function detailOf(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try {
    return `Non-error value thrown: ${JSON.stringify(err)}`;
  } catch {
    return `Non-error value thrown: ${String(err)}`;
  }
}

/**
 * Express error handler.
 * - production: only the safe message (never stack, driver text or 5xx messages)
 * - development/test: also the stack/detail
 * - /api paths (or Accept: application/json): JSON body, otherwise error.ejs
 * - if the response has already started, defer to Express (closes the socket)
 */
function createErrorHandler({ isProduction, logger }) {
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) {
      return next(err);
    }

    const { status, code, message } = normalizeError(err);
    const log = req.log || logger;
    const requestId = req.id;

    if (log) {
      if (status >= 500) {
        log.error({ err, status, code }, "request failed");
      } else {
        log.info({ status, code, errName: err && err.name }, "client error");
      }
    }

    const detail = isProduction ? undefined : detailOf(err);

    if (wantsJson(req)) {
      const body = { error: { status, code, message, requestId } };
      if (detail) body.error.detail = detail;
      return res.status(status).json(body);
    }

    res.status(status).render(
      "error.ejs",
      {
        status,
        title: titleFor(status),
        pageTitle: `${status} ${titleFor(status)}`,
        message,
        detail,
        requestId,
        // Defaults for the layout when the error happened before the locals
        // middleware ran (e.g. a session store failure).
        success: res.locals.success || [],
        error: res.locals.error || [],
        currUser: res.locals.currUser || null,
        currentPath: res.locals.currentPath || "",
        mapPublicToken: res.locals.mapPublicToken || "",
      },
      (renderErr, html) => {
        if (renderErr) {
          if (log) log.error({ err: renderErr }, "error page failed to render");
          res
            .status(status)
            .type("text/plain")
            .send(`${titleFor(status)}\n${message}`);
          return;
        }
        res.send(html);
      },
    );
  };
}

module.exports = { createErrorHandler, normalizeError };
