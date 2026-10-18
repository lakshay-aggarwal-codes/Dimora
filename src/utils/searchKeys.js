// Search keys (P05-T01): lower-case, accent-free copies of a listing's city,
// state and country, so "São Paulo", "sao paulo" and "SAO  PAULO" are the same
// place and an index can answer "starts with" questions. The same function
// builds the stored keys and the keys a visitor's search is compared with, so
// the two can never disagree.

const MAX_KEY = 100;
const MAX_PARTS = 3;
const MAX_PART = 60;

/** "  São  Paulo! " -> "sao paulo". Only letters, digits and single spaces survive ("Île-de-France" -> "ile de france"). */
function normaliseToken(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEY);
}

/**
 * Keys for one place.
 * @returns {{ cityKey: string, stateKey: string, countryKey: string, locationKey: string }}
 * `locationKey` joins the non-empty parts with "|" ("panaji|goa|india"): a
 * stable id for a destination, for grouping and (later) suggestions.
 */
function locationKeys({ city, state, country } = {}) {
  const cityKey = normaliseToken(city);
  const stateKey = normaliseToken(state);
  const countryKey = normaliseToken(country);
  return {
    cityKey,
    stateKey,
    countryKey,
    locationKey: [cityKey, stateKey, countryKey].filter(Boolean).join("|"),
  };
}

/**
 * Keys for a listing document or plain object. A listing that has no
 * structured address yet (written before the wizard) falls back to its old
 * free-text `location` ("Panaji, Goa": the first part is the city) and `country`.
 */
function keysForListing(listing) {
  const doc = listing || {};
  const get = (path) => (typeof doc.get === "function" ? doc.get(path) : undefined);
  const address = doc.address || {};
  let city = get("address.city") ?? address.city ?? get("location") ?? doc.location;
  let state = get("address.state") ?? address.state;
  // "Panaji, Goa" typed into one field: the first part is the city and, when
  // there is no state of its own, the second is the state.
  if (typeof city === "string" && city.includes(",")) {
    const [first, second] = city.split(",").map((part) => part.trim());
    city = first;
    if (!state && second) state = second;
  }
  return locationKeys({
    city,
    state,
    country: get("address.country") ?? address.country ?? get("country") ?? doc.country,
  });
}

/**
 * What a visitor typed in the destination box, as up to three normalised parts:
 * "Panaji, Goa" -> ["panaji", "goa"]. Each part must start a city, state or
 * country key. Empty parts are dropped.
 */
function destinationParts(input) {
  if (typeof input !== "string") return [];
  return input
    .split(",")
    .map((part) => normaliseToken(part).slice(0, MAX_PART))
    .filter(Boolean)
    .slice(0, MAX_PARTS);
}

/** Escapes a string for use inside a regular expression. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

module.exports = {
  normaliseToken,
  locationKeys,
  keysForListing,
  destinationParts,
  escapeRegex,
  MAX_PARTS,
};
