// P17-T05: what the request log says about a URL.
const assert = require("node:assert/strict");
const { redactPath } = require("../../src/utils/redactPath");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDe";

test("a one-time token in the path is replaced", () => {
  assert.equal(redactPath(`/reset-password/${TOKEN}`), "/reset-password/[redacted]");
  assert.equal(redactPath(`/verify-email/${TOKEN}`), "/verify-email/[redacted]");
  assert.equal(redactPath(`/reset-password/${TOKEN}/`), "/reset-password/[redacted]/");
});

test("the query string and fragment are dropped", () => {
  assert.equal(redactPath("/listings?q=goa&token=secret"), "/listings");
  assert.equal(redactPath(`/reset-password/${TOKEN}?x=1`), "/reset-password/[redacted]");
  assert.equal(redactPath("/listings#reviews"), "/listings");
});

test("any token-shaped segment is hidden, not only well-formed ones", () => {
  assert.equal(redactPath("/reset-password/short"), "/reset-password/[redacted]");
  assert.equal(redactPath("/verify-email/needed"), "/verify-email/[redacted]");
});

test("ordinary paths are unchanged", () => {
  for (const p of ["/", "/listings", "/listings/64b0000000000000000000a1", "/login", "/forgot-password", "/verify-email", "/reset-password"]) {
    assert.equal(redactPath(p), p);
  }
});

test("odd input does not throw", () => {
  assert.equal(redactPath(undefined), "");
  assert.equal(redactPath(null), "");
  assert.equal(redactPath(42), "42");
});
