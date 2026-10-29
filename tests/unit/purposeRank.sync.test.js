// P15-T06: the ranking's tie order is the page's normal Best-match order.
const assert = require("node:assert/strict");
const { sortSpec } = require("../../src/services/search");
const { NORMAL_ORDER } = require("../../src/services/purposeRank");

test("NORMAL_ORDER equals sortSpec('relevance') without words", () => {
  assert.deepEqual({ ...NORMAL_ORDER }, sortSpec("relevance").sort);
});
