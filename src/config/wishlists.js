// Limits and names for wishlists (P10-T01). `maxLists` is enforced when named
// lists arrive (P10-T02); until then every member has only the default list.
const LIMITS = Object.freeze({ maxLists: 20, maxItems: 100 });
const DEFAULT_NAME = "Saved";

module.exports = { LIMITS, DEFAULT_NAME };
