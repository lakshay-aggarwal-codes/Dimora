// JSON for a <script type="application/ld+json"> block (P17-T02).
//
// JSON.stringify alone is not safe there: a title like "</script><script>..."
// would close the block. The one implementation lives in
// src/utils/structuredData.js (`safeJson`, used by `listingJsonLd`, P04-T07);
// this name is kept for code that only needs the escaping. views/listings/show.ejs
// prints a `structuredData` local with the raw tag, so whatever sets it must be
// built with `listingJsonLd` or `jsonForScript`.
const { safeJson } = require("./structuredData");

module.exports = { jsonForScript: safeJson };
