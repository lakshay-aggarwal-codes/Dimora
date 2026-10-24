// Query of GET /compare?ids=a,b,c&in=&out=&guests=&place= (P10-T03).
//
// ids: 2 to 4 listing ids, as one comma list ("a,b,c"), repeated parameters
//      (checkboxes: ids=a&ids=b) or both. Duplicates count once.
// in, out, guests: optional as a group. With neither date the page shows
//      nightly prices only; with one date, or a bad date, it is a 400.
// place: optional text for "distance to ..." (looked up on the server).
const { ValidationError } = require("../utils/errors");
const { parseQuoteQuery } = require("./quoteQuery");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const MIN_STAYS = 2;
const MAX_STAYS = 4;
const MAX_PLACE = 120;
const MAX_RAW_PARTS = 40; // stops a huge ?ids= before any splitting work

const isBlank = (value) => value === undefined || value === "";

function parseIds(raw) {
  const values = [].concat(raw === undefined ? [] : raw);
  const ids = [];
  for (const value of values) {
    if (typeof value !== "string") {
      throw new ValidationError("The list of stays to compare is not valid.");
    }
    if (value.length > 400) {
      throw new ValidationError("You can compare up to 4 stays at a time.");
    }
    for (const part of value.split(",")) {
      const id = part.trim();
      if (!id) continue;
      if (!OBJECT_ID.test(id)) {
        throw new ValidationError("One of the stays in this link is not valid.");
      }
      const key = id.toLowerCase();
      if (!ids.includes(key)) ids.push(key);
      if (ids.length > MAX_RAW_PARTS) break;
    }
  }
  if (ids.length > MAX_STAYS) {
    throw new ValidationError(
      `You can compare up to ${MAX_STAYS} stays at a time.`,
    );
  }
  if (ids.length < MIN_STAYS) {
    throw new ValidationError(
      `Choose ${MIN_STAYS} to ${MAX_STAYS} stays to compare.`,
    );
  }
  return ids;
}

/** @returns {{ ids: string[], dates: {in:string,out:string,guests:number,checkIn:Date,checkOut:Date}|null, place: string }} */
function parseCompareQuery(query = {}) {
  const ids = parseIds(query.ids);

  let dates = null;
  if (!isBlank(query.in) || !isBlank(query.out)) {
    // Strict YYYY-MM-DD, guests a whole number: errors per field, as the quote API.
    const parsed = parseQuoteQuery({
      in: query.in,
      out: query.out,
      guests: isBlank(query.guests) ? "1" : query.guests,
    });
    dates = {
      in: query.in,
      out: query.out,
      guests: parsed.guests,
      checkIn: parsed.checkIn,
      checkOut: parsed.checkOut,
    };
  }

  let place = "";
  if (!isBlank(query.place)) {
    if (typeof query.place !== "string") {
      throw new ValidationError("The place is not valid.");
    }
    place = query.place.replace(/\s+/g, " ").trim();
    if (place.length > MAX_PLACE) {
      throw new ValidationError(`The place must be at most ${MAX_PLACE} characters.`);
    }
  }
  return { ids, dates, place };
}

module.exports = { parseCompareQuery, parseIds, MIN_STAYS, MAX_STAYS };
