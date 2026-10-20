// Typed application errors. Throw these from controllers/services; the error
// handler (src/middleware/errors.js) maps them to a status code and a safe page.
//
// `message` is written by us for the user, so it is shown as-is for 4xx errors.
// For 5xx the handler never shows it in production.

class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status
   * @param {string} message    user-safe text
   * @param {object} [options]
   * @param {string} [options.code]  stable machine-readable code
   * @param {unknown} [options.cause] underlying error (logged, never shown)
   */
  constructor(statusCode, message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code || "app_error";
  }
}

class ValidationError extends AppError {
  constructor(message = "The submitted data is not valid.", options) {
    super(400, message, { code: "validation_error", ...options });
  }
}

class ForbiddenError extends AppError {
  constructor(message = "You are not allowed to do that.", options) {
    super(403, message, { code: "forbidden", ...options });
  }
}

class NotFoundError extends AppError {
  constructor(message = "Page Not Found", options) {
    super(404, message, { code: "not_found", ...options });
  }
}

class ConflictError extends AppError {
  constructor(message = "That conflicts with the current state.", options) {
    super(409, message, { code: "conflict", ...options });
  }
}

// A state-machine move that is not allowed (used by the reservation lifecycle).
class InvalidTransitionError extends ConflictError {
  constructor(from, to, message) {
    super(message || `Cannot change status from ${from} to ${to}.`, {
      code: "invalid_transition",
    });
    this.from = from;
    this.to = to;
  }
}

// The pricing service cannot give a price for this listing (no valid nightly
// price, an unsupported currency...). 422: the request is fine, the listing is not.
class QuoteRefusedError extends AppError {
  constructor(
    message = "This listing cannot be priced right now.",
    options,
  ) {
    super(422, message, { code: "quote_refused", ...options });
  }
}

// The price the guest saw is no longer the price: carries the new quote so the
// checkout page can show the difference and ask again (P07-T05, P08-T03).
class PriceChangedError extends ConflictError {
  constructor(quote, message) {
    super(
      message || "The price has changed. Please review the new total.",
      { code: "price_changed" },
    );
    this.quote = quote;
  }
}

module.exports = {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidTransitionError,
  QuoteRefusedError,
  PriceChangedError,
};
