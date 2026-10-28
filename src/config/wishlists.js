// Limits and names for wishlists (P10-T01) and named lists, notes and saved
// searches (P10-T02).
const LIMITS = Object.freeze({ maxLists: 20, maxItems: 100 });
const DEFAULT_NAME = "Saved";
const NAME_MAX = 60;
const NOTE_MAX = 300;
const SEARCH_LIMITS = Object.freeze({ maxSaved: 20, nameMax: NAME_MAX, queryMax: 1000 });

module.exports = { LIMITS, DEFAULT_NAME, NAME_MAX, NOTE_MAX, SEARCH_LIMITS };
