// Saved searches (P10-T02): a name and the canonical query string of
// /listings. The query is built HERE from the validated search state
// (parseListingQuery, the same function the listings page uses), so what is
// stored is only known parameters with valid values, in a fixed order, without
// the page number; the browser's text is never stored or redirected to as is.
// The re-run link is "/listings?" + that string.
//
// Dates are stored as chosen: a saved search with dates that have passed shows
// the listings page's own message about them when it is run.
const { parseListingQuery } = require("../validation/searchQuery");
const { queryPairs } = require("../utils/searchUrl");
const { SEARCH_LIMITS } = require("../config/wishlists");
const { parseName } = require("./wishlistLists");
const { NotFoundError, ConflictError, ValidationError } = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function model(deps = {}) {
  return deps.SavedSearch || require("../models/savedSearch");
}

/**
 * The canonical query string for what a form or link sent.
 * @param {object} raw  req.body / req.query (without name and _csrf)
 * @returns {string} "dest=Goa&guests=2" ("" when nothing valid was set)
 */
function canonicalQuery(raw) {
  const { _csrf, name, ...rest } = raw && typeof raw === "object" ? raw : {};
  void _csrf;
  void name;
  const { state } = parseListingQuery(rest);
  // `page` is never saved, and neither is the sort order's default.
  const { page, ...kept } = state;
  void page;
  return new URLSearchParams(queryPairs(kept)).toString();
}

const hrefOf = (query) => `/listings?${query}`;

/** A short description of a query for the list ("Goa · 2 guests · 12 Nov to 15 Nov"). */
function describeQuery(query) {
  const p = new URLSearchParams(query);
  const parts = [];
  if (p.get("dest")) parts.push(p.get("radius") ? `${p.get("dest")} (within ${p.get("radius")} km)` : p.get("dest"));
  if (p.get("in") && p.get("out")) parts.push(`${p.get("in")} to ${p.get("out")}`);
  if (p.get("guests")) parts.push(`${p.get("guests")} guest${p.get("guests") === "1" ? "" : "s"}`);
  if (p.get("minPrice") || p.get("maxPrice")) {
    parts.push(`price ${p.get("minPrice") || "0"}${p.get("maxPrice") ? ` to ${p.get("maxPrice")}` : "+"}`);
  }
  if (p.get("type")) parts.push(p.get("type"));
  const other = [...p.keys()].filter(
    (k) => !["dest", "radius", "in", "out", "guests", "minPrice", "maxPrice", "type", "sort"].includes(k),
  );
  if (other.length) parts.push(`${new Set(other).size} more filter${new Set(other).size === 1 ? "" : "s"}`);
  return parts.join(" · ") || "All stays";
}

async function save(userId, { name, params }, deps) {
  const SavedSearch = model(deps);
  const clean = parseName(name);
  const query = (deps && deps.canonicalQuery ? deps.canonicalQuery : canonicalQuery)(params);
  if (!query) {
    throw new ValidationError("Set a destination, dates or a filter first: there is nothing to save in an empty search.");
  }
  if (query.length > SEARCH_LIMITS.queryMax) throw new ValidationError("That search is too long to save.");
  const count = await SavedSearch.countDocuments({ owner: userId });
  if (count >= SEARCH_LIMITS.maxSaved) {
    throw new ConflictError(`You can keep at most ${SEARCH_LIMITS.maxSaved} saved searches. Delete one first.`, {
      code: "too_many_searches",
    });
  }
  try {
    const doc = await SavedSearch.create({ owner: userId, name: clean, query });
    return { id: String(doc._id), name: doc.name, query, href: hrefOf(query) };
  } catch (err) {
    if (err && err.code === 11000) {
      throw new ConflictError("You already have a saved search with that name.", { code: "name_taken" });
    }
    throw err;
  }
}

/** The member's saved searches, newest first, with their re-run links. */
async function list(userId, deps) {
  const rows = await model(deps)
    .find({ owner: userId })
    .sort({ createdAt: -1 })
    .limit(SEARCH_LIMITS.maxSaved)
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    name: row.name,
    summary: describeQuery(row.query),
    href: hrefOf(row.query),
    createdAt: row.createdAt,
  }));
}

async function remove(userId, id, deps) {
  if (!OBJECT_ID.test(String(id))) throw new NotFoundError("That saved search does not exist.");
  const result = await model(deps).deleteOne({ _id: id, owner: userId });
  if (!result.deletedCount) throw new NotFoundError("That saved search does not exist.");
  return { removed: true };
}

module.exports = { save, list, remove, canonicalQuery, describeQuery };
