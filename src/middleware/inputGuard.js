// Input guard (P17-T02): refuses request input that is shaped like an attack
// before any controller sees it.
//
// 1. Operator and path injection. A key that contains "$" or "." (`email[$ne]=x`,
//    `a.b=1`), or is named __proto__/constructor/prototype, has no place in any
//    form or query this site accepts. Left alone, a nested value can end up
//    inside a database filter (`{ username: { $ne: "" } }`) or an update.
//    The request is refused (400), not silently cleaned, so a probe is visible
//    in the logs and in tests.
// 2. Shape. Nesting deeper than 8 levels, more than 5,000 values, or a NUL
//    character in a string is refused too.
//
// It looks at req.query and req.body. Run it right after the urlencoded parser
// (app.js), and again right after every multer middleware, because multer
// parses its text fields later than the urlencoded parser and builds nested
// objects the same way.
//
// Duplicate parameters (?q=a&q=b, "HPP") are NOT refused here: some parameters
// legitimately repeat (checkboxes, ?ids=). Every query parser handles arrays on
// purpose, and tests/unit/inputParsers.test.js pins how.
const { ValidationError } = require("../utils/errors");

// Size limits of the form parser. 100 kb is far above any form of this site
// (the largest text field, a listing description, is capped lower by Joi);
// anything bigger answers 413 (see src/middleware/errors.js).
const URLENCODED_OPTIONS = Object.freeze({
  extended: true,
  limit: "100kb",
  parameterLimit: 1000,
});

const MAX_DEPTH = 8;
const MAX_VALUES = 5000;
// "$" or "." anywhere, or a prototype name (also as the start of a flat key such as "__proto__[x]").
const BAD_KEY = /[$.]|^(?:__proto__|constructor|prototype)(?:\[|$)/;

/**
 * @returns {null | { reason: "operator_key"|"nul"|"too_deep"|"too_large", path: string }}
 *   `path` names keys only (never values), safe to log.
 */
function findUnsafeInput(root) {
  const stack = [{ value: root, path: "", depth: 0 }];
  let seen = 0;
  while (stack.length) {
    const { value, path, depth } = stack.pop();
    seen += 1;
    if (seen > MAX_VALUES) return { reason: "too_large", path };
    if (typeof value === "string") {
      if (value.includes("\u0000")) return { reason: "nul", path };
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (depth >= MAX_DEPTH) return { reason: "too_deep", path };
    if (Array.isArray(value)) {
      value.forEach((item, i) =>
        stack.push({ value: item, path: `${path}[${i}]`, depth: depth + 1 }),
      );
      continue;
    }
    for (const key of Object.keys(value)) {
      const here = path ? `${path}.${key}` : key;
      if (BAD_KEY.test(key)) return { reason: "operator_key", path: here };
      stack.push({ value: value[key], path: here, depth: depth + 1 });
    }
  }
  return null;
}

function inputGuard(req, res, next) {
  for (const where of ["query", "body"]) {
    const found = findUnsafeInput(req[where]);
    if (found) {
      if (req.log) {
        req.log.warn(
          { where, reason: found.reason, path: found.path.slice(0, 80) },
          "request input refused",
        );
      }
      return next(new ValidationError("That request contains input we do not accept."));
    }
  }
  return next();
}

module.exports = { inputGuard, findUnsafeInput, URLENCODED_OPTIONS };
