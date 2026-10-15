// Per-page <title> and meta description (P03-T02). Controllers pass `pageTitle`
// and optionally `pageDescription` to res.render; the layout turns them into
// the tags with these helpers (registered as app.locals in app.js).
const SITE_NAME = "Dimora";
const DEFAULT_DESCRIPTION =
  "Dimora is a place to find a stay, or to list your own home and welcome guests.";
const TITLE_MAX = 70;
const DESCRIPTION_MAX = 160;

const squash = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** "Page name | Dimora"; just "Dimora" when the page gives no name. */
function fullTitle(pageTitle) {
  let title = squash(pageTitle);
  if (!title) return SITE_NAME;
  if (title.length > TITLE_MAX)
    title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return `${title} | ${SITE_NAME}`;
}

/** The page's own description, shortened at a word boundary; else the site default. */
function metaDescription(pageDescription) {
  const text = squash(pageDescription);
  if (!text) return DEFAULT_DESCRIPTION;
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 80 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

module.exports = { SITE_NAME, DEFAULT_DESCRIPTION, fullTitle, metaDescription };
