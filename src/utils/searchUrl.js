// Links for the listings page (P05-T02). Every link on the page (search form,
// filters, sort, pagination) is made here from the page's validated state, so
// the query is never lost and never invented.
const ORDER = [
  "dest",
  "radius",
  "in",
  "out",
  "guests",
  "flex",
  "category",
  "minPrice",
  "maxPrice",
  "type",
  "amenities",
  "access",
  "minRating",
  "sort",
  "purpose",
  "page",
  "keywords",
  "bedrooms",
  "roomType",
  "instantBook",
];

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/**
 * The parameters of a link: `state` with `changes` applied (`undefined`, `""`
 * or [] removes one), in a fixed order, page 1 left out. Changing anything
 * but `page` goes back to page 1.
 * @returns {Array<[string, string]>}
 */
function queryPairs(state = {}, changes = {}) {
  const merged = { ...state, ...changes };
  if (!Object.hasOwn(changes, "page")) delete merged.page;
  if (merged.page === 1 || merged.page === "1") delete merged.page;
  const pairs = [];
  for (const name of ORDER) {
    const value = merged[name];
    if (isEmpty(value)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      pairs.push([name, String(item)]);
    }
  }
  return pairs;
}

/** "/listings?dest=Goa&guests=2" (just "/listings" when nothing is set). */
function listingsUrl(state, changes) {
  const params = new URLSearchParams(queryPairs(state, changes));
  const text = params.toString();
  return text ? `/listings?${text}` : "/listings";
}

/** Pairs for hidden inputs that carry the rest of the state through a form. */
function hiddenFields(state, except = []) {
  const skip = new Set([...except, "page"]);
  return queryPairs(state).filter(([name]) => !skip.has(name));
}

module.exports = { queryPairs, listingsUrl, hiddenFields, ORDER };
