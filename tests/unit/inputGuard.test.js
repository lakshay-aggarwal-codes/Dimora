// P17-T02: the input guard's rules, on plain objects (no server needed).
const { findUnsafeInput, inputGuard, URLENCODED_OPTIONS } = require("../../src/middleware/inputGuard");

const deep = (levels) => {
  let node = "leaf";
  for (let i = 0; i < levels; i++) node = { n: node };
  return node;
};

describe("findUnsafeInput", () => {
  test("clean forms and queries pass, including nested form fields and arrays", () => {
    expect(findUnsafeInput({ listing: { title: "Sea house", price: "5000", amenities: ["wifi", "pool"] } })).toBe(null);
    expect(findUnsafeInput({ ids: ["a", "b"], in: "2026-12-01", place: "Panaji, Goa" })).toBe(null);
    expect(findUnsafeInput({ review: { rating: "5", comment: "Nice \u2013 caf\u00e9 \u{1F600}" } })).toBe(null);
    expect(findUnsafeInput(undefined)).toBe(null);
    expect(findUnsafeInput({})).toBe(null);
  });

  test("operator keys are refused at any depth, in objects and inside arrays", () => {
    expect(findUnsafeInput({ username: { $ne: "" } })).toEqual({ reason: "operator_key", path: "username.$ne" });
    expect(findUnsafeInput({ listing: { title: { $regex: ".*" } } }).reason).toBe("operator_key");
    expect(findUnsafeInput({ list: [{ $gt: "" }] }).path).toBe("list[0].$gt");
    expect(findUnsafeInput({ $where: "1" }).reason).toBe("operator_key");
  });

  test("flat keys that spell an operator or a path are refused too (Express 5 keeps `a[$ne]` as one key)", () => {
    expect(findUnsafeInput({ "email[$ne]": "x" }).reason).toBe("operator_key");
    expect(findUnsafeInput({ "profile.role": "admin" }).reason).toBe("operator_key");
  });

  test("prototype keys are refused", () => {
    expect(findUnsafeInput(JSON.parse('{"__proto__": {"admin": true}}')).reason).toBe("operator_key");
    expect(findUnsafeInput({ constructor: { prototype: {} } }).reason).toBe("operator_key");
    expect(findUnsafeInput({ "__proto__[admin]": "1" }).reason).toBe("operator_key");
    expect(findUnsafeInput({ constructors: "fine", prototypeName: "fine" })).toBe(null); // only exact names
  });

  test("a NUL character, absurd nesting and a flood of values are refused", () => {
    expect(findUnsafeInput({ q: "a\u0000b" }).reason).toBe("nul");
    expect(findUnsafeInput(deep(7))).toBe(null);
    expect(findUnsafeInput(deep(12)).reason).toBe("too_deep");
    const flood = {};
    for (let i = 0; i < 6000; i++) flood[`k${i}`] = "v";
    expect(findUnsafeInput(flood).reason).toBe("too_large");
  });

  test("the answer names keys, never values (safe to log)", () => {
    const found = findUnsafeInput({ password: { $ne: "super-secret-value" } });
    expect(JSON.stringify(found).includes("super-secret-value")).toBe(false);
  });
});

describe("inputGuard middleware", () => {
  const run = (req) => {
    const warnings = [];
    let outcome;
    inputGuard({ ...req, log: { warn: (...a) => warnings.push(a) } }, {}, (err) => {
      outcome = err || null;
    });
    return { outcome, warnings };
  };

  test("passes clean requests on without an error", () => {
    expect(run({ query: { page: "2" }, body: { listing: { title: "x" } } }).outcome).toBe(null);
    expect(run({ query: {} }).outcome).toBe(null); // no body parsed (GET)
  });

  test("refuses a bad query or body with a 400, and logs the key but not the value", () => {
    const bad = run({ query: {}, body: { username: { $ne: "x" }, password: "hunter2" } });
    expect(bad.outcome.statusCode).toBe(400);
    expect(bad.warnings.length).toBe(1);
    expect(bad.warnings[0][0]).toEqual({ where: "body", reason: "operator_key", path: "username.$ne" });
    expect(JSON.stringify(bad.warnings).includes("hunter2")).toBe(false);
    expect(run({ query: { "a[$ne]": "1" }, body: {} }).outcome.statusCode).toBe(400);
  });
});

describe("form parser limits", () => {
  test("100 kb and 1000 parameters, stated explicitly", () => {
    expect(URLENCODED_OPTIONS.limit).toBe("100kb");
    expect(URLENCODED_OPTIONS.parameterLimit).toBe(1000);
    expect(URLENCODED_OPTIONS.extended).toBe(true);
  });
});
