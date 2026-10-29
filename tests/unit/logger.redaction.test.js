// P17-T05: nothing secret reaches the log, whichever way it is logged.
const assert = require("node:assert/strict");
const { memoryLog } = require("../helpers/logCapture");
const { REDACT_PATHS } = require("../../src/config/logger");

const SECRET = "S3cret-value-xyz";

function logged(payload, message = "test") {
  const m = memoryLog();
  m.logger.info(payload, message);
  return m.text();
}

test("password-like fields are censored at the top level and one level down", () => {
  for (const key of ["password", "newPassword", "currentPassword", "confirmPassword", "hash", "salt", "token", "tokenHash"]) {
    assert.equal(logged({ [key]: SECRET }).includes(SECRET), false, key);
    assert.equal(logged({ user: { [key]: SECRET } }).includes(SECRET), false, `user.${key}`);
  }
});

test("headers that carry credentials are censored", () => {
  const text = logged({
    req: { headers: { cookie: `connect.sid=${SECRET}`, authorization: `Bearer ${SECRET}`, accept: "text/html" } },
    res: { headers: { "set-cookie": [`connect.sid=${SECRET}`] } },
  });
  assert.equal(text.includes(SECRET), false);
  assert.ok(text.includes("text/html"), "other headers are not touched");
});

test("a database error does not print the duplicate value or the request config", () => {
  const err = Object.assign(new Error("E11000 duplicate key"), { keyValue: { email: SECRET }, config: { headers: { Authorization: SECRET } } });
  assert.equal(logged({ err }).includes(SECRET), false);
});

test("settings and keys that might be logged by mistake are censored", () => {
  const text = logged({
    cfg: { apiSecret: SECRET, resendApiKey: SECRET, sessionSecret: SECRET, mongodbUri: `mongodb+srv://u:${SECRET}@h/db` },
  });
  assert.equal(text.includes(SECRET), false);
});

test("the censor text is used and ordinary values survive", () => {
  const text = logged({ password: SECRET, listing: "abc", count: 3 });
  assert.match(text, /\[Redacted\]/);
  assert.match(text, /"listing":"abc"/);
});

test("the list of paths is the documented one (a path removed by accident fails here)", () => {
  for (const path of ["req.headers.cookie", "req.headers.authorization", "password", "*.password", "hash", "salt", "err.keyValue", "newPassword", "token", "tokenHash"]) {
    assert.ok(REDACT_PATHS.includes(path), path);
  }
});
