// Query of GET /api/listings/:id/quote?in=&out=&guests= (P08-T02). Only plain
// strings are accepted (a repeated parameter or in[x]=y is refused), dates are
// strict YYYY-MM-DD (ADR-003), guests a whole number. Problems are reported
// per field so the page can show each next to its input.
const { tryParseDateOnly, isAfter } = require("../utils/dates");
const { ValidationError } = require("../utils/errors");

const GUESTS = /^\d{1,3}$/;

function dateField(query, name, label, fields) {
  const raw = query ? query[name] : undefined;
  if (raw === undefined || raw === "") {
    fields[name] = `${label} is required (YYYY-MM-DD).`;
    return null;
  }
  const date = typeof raw === "string" ? tryParseDateOnly(raw) : null;
  if (!date) {
    fields[name] = `${label} must be a valid date in YYYY-MM-DD format.`;
    return null;
  }
  return date;
}

/**
 * @returns {{checkIn: Date, checkOut: Date, guests: number}}
 * @throws {ValidationError} 400, with `.fields` = { in?, out?, guests? }
 */
function parseQuoteQuery(query) {
  const fields = {};
  const checkIn = dateField(query, "in", "Check-in", fields);
  const checkOut = dateField(query, "out", "Check-out", fields);
  if (checkIn && checkOut && !isAfter(checkOut, checkIn)) {
    fields.out = "Check-out must be after check-in.";
  }
  const rawGuests = query ? query.guests : undefined;
  let guests = null;
  if (rawGuests === undefined || rawGuests === "") {
    fields.guests = "Guests is required (a whole number, 1 or more).";
  } else if (
    typeof rawGuests !== "string" ||
    !GUESTS.test(rawGuests) ||
    Number(rawGuests) < 1
  ) {
    fields.guests = "Guests must be a whole number, 1 or more.";
  } else {
    guests = Number(rawGuests); // the place's own capacity is a booking rule
  }
  const names = Object.keys(fields);
  if (names.length > 0) {
    const err = new ValidationError(fields[names[0]]);
    err.fields = fields;
    throw err;
  }
  return { checkIn, checkOut, guests };
}

module.exports = { parseQuoteQuery };
