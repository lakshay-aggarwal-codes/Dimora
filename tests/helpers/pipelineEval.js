// A tiny interpreter for the MongoDB update-pipeline expressions that
// services/ratings.js uses, so the aggregate tests can run without a database.
// It supports only: $set stages, field paths ("$x"), $$variables, $ifNull, $add,
// $max, $divide, $cond, $gt, $ne, $concatArrays, $filter, and array/number/
// ObjectId literals. Anything else throws, so a new operator in the service
// fails these tests loudly instead of being silently ignored.
const same = (a, b) => String(a) === String(b);

function evaluate(expr, doc, vars = {}) {
  if (typeof expr === "string") {
    if (expr.startsWith("$$")) return vars[expr.slice(2)];
    if (expr.startsWith("$")) return doc[expr.slice(1)];
    return expr;
  }
  if (Array.isArray(expr)) return expr.map((e) => evaluate(e, doc, vars));
  if (
    expr === null ||
    typeof expr !== "object" ||
    typeof expr.toHexString === "function"
  )
    return expr;
  const keys = Object.keys(expr);
  if (keys.length !== 1 || !keys[0].startsWith("$"))
    throw new Error(`unsupported expression ${JSON.stringify(expr)}`);
  const op = keys[0];
  const arg = expr[op];
  switch (op) {
    case "$ifNull": {
      const [value, fallback] = arg.map((a) => evaluate(a, doc, vars));
      return value === undefined || value === null ? fallback : value;
    }
    case "$add":
      return arg.map((a) => evaluate(a, doc, vars)).reduce((t, n) => t + n, 0);
    case "$max":
      return Math.max(...arg.map((a) => evaluate(a, doc, vars)));
    case "$divide": {
      const [a, b] = arg.map((x) => evaluate(x, doc, vars));
      return a / b;
    }
    case "$gt": {
      const [a, b] = arg.map((x) => evaluate(x, doc, vars));
      return a > b;
    }
    case "$ne": {
      const [a, b] = arg.map((x) => evaluate(x, doc, vars));
      return !same(a, b);
    }
    case "$cond": {
      const [test, yes, no] = arg;
      return evaluate(test, doc, vars)
        ? evaluate(yes, doc, vars)
        : evaluate(no, doc, vars);
    }
    case "$concatArrays":
      return arg.flatMap((a) => evaluate(a, doc, vars));
    case "$filter": {
      const list = evaluate(arg.input, doc, vars);
      return list.filter((item) =>
        evaluate(arg.cond, doc, { ...vars, [arg.as]: item }),
      );
    }
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

/** Apply an update pipeline to a copy of `doc` and return it. Stages run in order. */
function applyPipeline(doc, pipeline) {
  let current = { ...doc };
  for (const stage of pipeline) {
    const keys = Object.keys(stage);
    if (keys.length !== 1 || keys[0] !== "$set")
      throw new Error(`unsupported stage ${keys}`);
    const next = { ...current };
    for (const [field, expr] of Object.entries(stage.$set))
      next[field] = evaluate(expr, current);
    current = next;
  }
  return current;
}

module.exports = { evaluate, applyPipeline };
