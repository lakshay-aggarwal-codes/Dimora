// Legacy error type, kept so existing `new ExpressError(status, message)` calls
// keep working. New code should throw the typed errors in ./errors.js.
const { AppError } = require("./errors");

class ExpressError extends AppError {
  constructor(statusCode, message) {
    super(statusCode, message);
  }
}

module.exports = ExpressError;
