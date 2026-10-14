// P02-T02: only same-site paths survive.
const { safeRedirectPath } = require("../../src/utils/safeRedirect");

describe("safeRedirectPath", () => {
  test.each([
    "/listings",
    "/listings/66b0f0f0f0f0f0f0f0f0f0f0",
    "/listings?page=2&sort=price",
    "/listings/abc#reviews",
    "/",
  ])("keeps the local path %j", (value) => {
    expect(safeRedirectPath(value, "/fallback")).toBe(value);
  });

  test.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/listings"],
    ["slash-backslash", "/\\evil.com"],
    ["backslash host", "\\\\evil.com"],
    ["absolute http", "http://evil.com"],
    ["absolute https", "https://evil.com/listings"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["no leading slash", "evil.com"],
    ["relative path", "listings"],
    ["dot segments to a host", "/..//evil.com"],
    ["tab inside", "/\t/evil.com"],
    ["newline (header injection)", "/listings\r\nSet-Cookie: a=b"],
    ["NUL byte", "/listings\u0000"],
    ["backslash inside", "/listings\\..\\evil"],
    ["empty", ""],
    ["login loop", "/login"],
    ["signup loop", "/signup?x=1"],
    ["logout", "/logout"],
    ["too long", `/${"a".repeat(3000)}`],
  ])("refuses %s", (_label, value) => {
    expect(safeRedirectPath(value, "/fallback")).toBe("/fallback");
  });

  test.each([undefined, null, 5, {}, ["/listings"], true])(
    "refuses a non-string (%j)",
    (value) => {
      expect(safeRedirectPath(value, "/fallback")).toBe("/fallback");
    },
  );

  test("the default fallback is /", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("//evil.com", null)).toBeNull();
  });
});
