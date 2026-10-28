// P12-T05: the partial prints what it is given and the honest note.
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");
const { buildTrust } = require("../../src/services/trust");

const file = path.join(__dirname, "..", "..", "views", "partials", "trust.ejs");
const render = (trust) => ejs.renderFile(file, { trust });

test("it lists each item and explains what 'confirmed' means", async () => {
  const html = await render(buildTrust({ emailConfirmed: true, memberSince: "March 2026", stats: { staysHosted: 2, answered: 5, expired: 0 } }));
  for (const key of ["email", "since", "stays", "response"]) assert.ok(html.includes(`data-trust-item="${key}"`), key);
  assert.ok(html.includes("data-trust-note"));
  assert.match(html, /does not check anyone's identity/);
});

test("the note is left out when nothing is confirmed, and nothing at all when there are no facts", async () => {
  const some = await render(buildTrust({ emailConfirmed: false, memberSince: "March 2026" }));
  assert.equal(some.includes("data-trust-note"), false);
  assert.equal((await render(buildTrust({ emailConfirmed: false, memberSince: "" }))).trim(), "");
  assert.equal((await render(null)).trim(), "");
});

test("text is escaped", async () => {
  const html = await render({ emailConfirmed: false, items: [{ key: "since", text: "<script>x</script>" }] });
  assert.equal(html.includes("<script>"), false);
});
