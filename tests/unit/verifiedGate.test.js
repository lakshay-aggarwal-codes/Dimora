// P02-T05: ensureVerifiedEmail.
const assert = require("node:assert/strict");
const { ensureVerifiedEmail, isEmailVerified, MESSAGE } = require("../../src/middleware/verified");

function fake({ required = true, user } = {}) {
  const out = { flashed: [], redirected: null };
  return {
    out,
    req: { app: { locals: { emailVerificationRequired: required } }, user, flash: (k, m) => out.flashed.push([k, m]) },
    res: { redirect: (to) => (out.redirected = to) },
  };
}

test("a confirmed member passes", () => {
  const { req, res, out } = fake({ user: { emailVerifiedAt: new Date() } });
  assert.equal(ensureVerifiedEmail(req, res), true);
  assert.equal(out.redirected, null);
});

test("an unconfirmed member is sent to /verify-email/needed with a message", () => {
  const { req, res, out } = fake({ user: { emailVerifiedAt: null } });
  assert.equal(ensureVerifiedEmail(req, res), false);
  assert.equal(out.redirected, "/verify-email/needed");
  assert.deepEqual(out.flashed, [["error", MESSAGE]]);
});

test("a user without the field, and nobody at all, count as unconfirmed", () => {
  assert.equal(isEmailVerified({}), false);
  assert.equal(isEmailVerified(undefined), false);
  const { req, res } = fake({ user: undefined });
  assert.equal(ensureVerifiedEmail(req, res), false);
});

test("with verification switched off everybody passes", () => {
  const { req, res, out } = fake({ required: false, user: { emailVerifiedAt: null } });
  assert.equal(ensureVerifiedEmail(req, res), true);
  assert.equal(out.redirected, null);
});
