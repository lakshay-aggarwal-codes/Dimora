// Destination suggestions for the search boxes (P05-T06). From the cities and
// countries of stays that really are public, nothing from a third party.
//
//   "pan"        -> cities starting "pan", and countries starting "pan"
//   "panaji, g"  -> cities starting "panaji" in a state starting "g"
//
// Each suggestion is "City, State, Country" as the host wrote it, with the number
// of public stays, and a `dest` that is guaranteed to find those stays: when the
// written text would not normalise to the stored keys, the keys are used instead
// (same rule as the empty-search suggestions, P05-T05).
//
// One aggregation, answered from the (status, cityKey) / (status, countryKey)
// indexes: at most MAX_SUGGESTIONS rows come back, whatever the data size.
const { publicListingFilter } = require("../utils/visibility");
const { destinationParts, normaliseToken } = require("../utils/searchKeys");

const MIN_CHARS = 2;
const MAX_QUERY = 100;
const MAX_SUGGESTIONS = 8;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (text) => new RegExp(`^${escapeRegex(text)}`);

/** The match condition for what was typed, or null when it is too short to search. */
function conditionFor(input) {
  if (typeof input !== "string") return null;
  const parts = destinationParts(input.slice(0, MAX_QUERY));
  if (parts.length === 0 || parts[0].length < MIN_CHARS) return null;
  if (parts.length === 1) {
    return { $or: [{ cityKey: startsWith(parts[0]) }, { countryKey: startsWith(parts[0]) }] };
  }
  const cond = { cityKey: startsWith(parts[0]), stateKey: startsWith(parts[1]) };
  if (parts[2]) cond.countryKey = startsWith(parts[2]);
  return cond;
}

const firstPart = (text) => String(text || "").split(",")[0].trim();

function present(group) {
  const { cityKey = "", stateKey = "", countryKey = "" } = group._id || {};
  const expected = [cityKey, stateKey, countryKey].filter(Boolean);
  const written = [
    firstPart(group.city) || firstPart(group.location),
    group.state,
    group.country,
  ]
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  const label = written.join(", ");
  const parts = destinationParts(label);
  const safe =
    parts.length === expected.length && parts.every((p, i) => expected[i].startsWith(p));
  const text = safe ? label : expected.join(", ");
  return { label: text, dest: text, count: group.count };
}

/**
 * @param {object} args
 * @param {object} args.Listing  the model
 * @param {string} args.q        what the visitor typed
 * @returns {Promise<Array<{ label: string, dest: string, count: number }>>}
 */
async function suggestDestinations({ Listing, q, limit = MAX_SUGGESTIONS }) {
  const cond = conditionFor(q);
  if (!cond) return [];
  const groups = await Listing.aggregate([
    { $match: { ...publicListingFilter(), ...cond } },
    {
      $group: {
        _id: { cityKey: "$cityKey", stateKey: "$stateKey", countryKey: "$countryKey" },
        count: { $sum: 1 },
        city: { $first: "$address.city" },
        state: { $first: "$address.state" },
        country: { $first: "$address.country" },
        location: { $first: "$location" },
      },
    },
    { $sort: { count: -1, "_id.cityKey": 1, "_id.stateKey": 1, "_id.countryKey": 1 } },
    { $limit: Math.min(limit, MAX_SUGGESTIONS) },
  ]);
  const seen = new Set();
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !group._id || !group._id.cityKey) continue;
    const item = present(group);
    if (!item.dest || seen.has(item.dest)) continue;
    seen.add(item.dest);
    out.push(item);
  }
  return out;
}

module.exports = {
  MIN_CHARS,
  MAX_SUGGESTIONS,
  conditionFor,
  present,
  suggestDestinations,
  normaliseToken,
};
