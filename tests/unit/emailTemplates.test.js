// P02-T05: the email texts.
const assert = require("node:assert/strict");
const t = require("../../src/emails/templates");

const LINK = "https://dimora.example.com/reset-password/abc_DEF-123";

test("the reset email has the link in both parts and states the lifetime", () => {
  const m = t.resetPassword({ name: "Ann", link: LINK, minutes: 60 });
  assert.ok(m.text.includes(LINK));
  assert.ok(m.html.includes(`href="${LINK}"`));
  assert.match(m.text, /60 minutes/);
  assert.match(m.subject, /Reset/);
  assert.equal(/[\r\n]/.test(m.subject), false);
});

test("the verification email names the 24 hour lifetime", () => {
  const m = t.verifyEmail({ name: "Ann", link: LINK, hours: 24 });
  assert.match(m.text, /24 hours/);
  assert.ok(m.html.includes(LINK));
});

test("a name with markup is escaped in the HTML part and cannot add a tag", () => {
  const name = '<img src=x onerror="alert(1)">&"\'';
  for (const m of [
    t.verifyEmail({ name, link: LINK, hours: 24 }),
    t.resetPassword({ name, link: LINK, minutes: 60 }),
    t.passwordChanged({ name }),
  ]) {
    assert.equal(m.html.includes("<img"), false);
    assert.ok(m.html.includes("&lt;img"));
  }
});

test("a link with quotes cannot break out of the href", () => {
  const m = t.verifyEmail({ name: "A", link: 'https://x.test/"><script>1</script>', hours: 24 });
  assert.equal(m.html.includes("<script>"), false);
});

test("the password-changed note has no link to click", () => {
  const m = t.passwordChanged({ name: "Ann" });
  assert.equal(/https?:\/\//.test(m.text), false);
  assert.equal(/href=/.test(m.html), false);
});
