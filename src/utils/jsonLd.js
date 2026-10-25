// JSON for a <script type="application/ld+json"> block (P17-T02).
//
// JSON.stringify alone is not safe there: a title like "</script><script>..."
// would close the block. "<", ">" and "&" are written as \u escapes (still the
// same JSON for a parser) and so are the two line separators that end a
// JavaScript string. views/listings/show.ejs prints a `structuredData` local
// with <%- %>; whoever sets it (P18-T05) must build it with this function.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

module.exports = { jsonForScript };
