// A reason typed by a person who declines or cancels a booking (P09-T02,
// P09-T03): optional text, up to 500 characters. Too long is refused, never cut.
const { ValidationError } = require("./errors");

const REASON_MAX = 500;

/** @returns {string} the trimmed reason, "" when there is none */
function parseReason(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string")
    throw new ValidationError("The reason must be text.");
  const text = raw.trim();
  if (text.length > REASON_MAX) {
    throw new ValidationError(
      `The reason can be at most ${REASON_MAX} characters.`,
    );
  }
  return text;
}

module.exports = { parseReason, REASON_MAX };
