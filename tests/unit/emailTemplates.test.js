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

test("notification email: title, body, absolute link, escaped HTML and the stop link (P11-T05)", () => {
  const { notification } = require("../../src/emails/templates");
  const m = notification({
    name: "Ravi",
    title: "Booked: <b>Sea</b>\nhouse",
    body: "12 Nov <script>",
    link: "https://dimora.test/trips/1",
    groupLabel: "Bookings",
    unsubscribeLink: "https://dimora.test/email/unsubscribe/tok",
  });
  assert.equal(m.subject.includes("\n"), false);
  assert.ok(m.text.includes("https://dimora.test/trips/1"));
  assert.ok(m.text.includes("Stop these emails: https://dimora.test/email/unsubscribe/tok"));
  assert.equal(m.html.includes("<script>"), false);
  assert.equal(m.html.includes("<b>Sea"), false);
  assert.ok(m.html.includes("Stop these emails"));
  const essential = notification({ name: "R", title: "t", link: "https://dimora.test/", groupLabel: "Decisions" });
  assert.equal(essential.text.includes("unsubscribe"), false);
  assert.ok(essential.text.includes("cannot be turned off"));
});
