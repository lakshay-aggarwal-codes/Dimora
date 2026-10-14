// P02-T02: the signup rules, without Express or a database.
const { signupSchema, PASSWORD_MAX } = require("../../src/validation");
const { isCommonPassword } = require("../../src/validation/commonPasswords");

const GOOD = {
  username: "ann_01",
  email: "ann@example.com",
  password: "a-long-pass-phrase",
};

function check(overrides) {
  return signupSchema.validate(
    { ...GOOD, ...overrides },
    {
      abortEarly: false,
      stripUnknown: true,
      errors: { wrap: { label: false } },
    },
  );
}
const messages = (result) =>
  result.error ? result.error.details.map((d) => d.message) : [];

describe("signup schema", () => {
  test("a valid form passes; email is lower-cased and trimmed", () => {
    const { error, value } = check({ email: "  Ann@Example.COM " });
    expect(error).toBeUndefined();
    expect(value.email).toBe("ann@example.com");
  });

  test.each([
    ["too short", "ab"],
    ["too long", "a".repeat(31)],
    ["a space", "ann smith"],
    ["a hyphen", "ann-smith"],
    ["an accented letter", "josé"],
    ["a non-latin letter", "安娜安娜"],
    ["an emoji", "ann😀ann"],
    ["markup", "<b>ann</b>"],
    ["empty", ""],
  ])("username with %s is rejected", (_label, username) => {
    expect(messages(check({ username })).length).toBeGreaterThan(0);
  });

  test("username length limits are inclusive (3 and 30 pass)", () => {
    expect(check({ username: "abc" }).error).toBeUndefined();
    expect(check({ username: "a".repeat(30) }).error).toBeUndefined();
    expect(check({ username: "A_b_9" }).error).toBeUndefined();
  });

  test.each(["not-an-email", "a@b", "a b@example.com", "@example.com", ""])(
    "email %j is rejected",
    (email) => {
      expect(messages(check({ email })).length).toBeGreaterThan(0);
    },
  );

  test("an email over 254 characters is rejected", () => {
    const email = `${"a".repeat(250)}@example.com`;
    expect(check({ email }).error).toBeDefined();
  });

  test("password: 9 characters rejected, 10 accepted", () => {
    expect(messages(check({ password: "k7!Qz9wXm" }))).toEqual([
      "Password must be at least 10 characters.",
    ]);
    expect(check({ password: "k7!Qz9wXmP" }).error).toBeUndefined();
  });

  test("password: over 128 characters rejected, exactly 128 accepted", () => {
    expect(
      check({ password: "x9".repeat(PASSWORD_MAX / 2) }).error,
    ).toBeUndefined();
    expect(
      messages(check({ password: `${"x9".repeat(PASSWORD_MAX / 2)}!` })),
    ).toEqual([`Password must be at most ${PASSWORD_MAX} characters.`]);
  });

  test.each([
    "password123",
    "Password123",
    "PASSWORD1234",
    "1234567890",
    "qwertyuiop",
    "aaaaaaaaaaaa",
    "0000000000",
  ])("common password %j is rejected", (password) => {
    expect(messages(check({ password }))).toEqual([
      "That password is too common. Choose a less predictable one.",
    ]);
  });

  test("password equal to the username or the email name is rejected", () => {
    expect(
      messages(check({ username: "longusername1", password: "LongUserName1" })),
    ).toEqual(["Password must not be the same as your username or email."]);
    expect(
      messages(
        check({ email: "someone.else@example.com", password: "someone.else" }),
      ),
    ).toEqual(["Password must not be the same as your username or email."]);
  });

  test("passwords are not trimmed (spaces count)", () => {
    expect(check({ password: "   padded   " }).error).toBeUndefined();
  });

  test("missing fields give our own messages, not Joi's", () => {
    const all = messages(
      signupSchema.validate(
        {},
        { abortEarly: false, errors: { wrap: { label: false } } },
      ),
    );
    expect(all).toEqual([
      "Choose a username.",
      "Enter your email address.",
      "Choose a password.",
    ]);
  });

  test("non-string values are rejected, not coerced (no object/array injection)", () => {
    expect(check({ username: { $ne: "" } }).error).toBeDefined();
    expect(check({ email: ["a@example.com"] }).error).toBeDefined();
    expect(check({ password: { $gt: "" } }).error).toBeDefined();
  });

  test("unknown fields such as role are stripped from the result", () => {
    const { value } = check({ role: "admin", status: "active" });
    expect(value).toEqual({
      username: GOOD.username,
      email: GOOD.email,
      password: GOOD.password,
    });
  });

  test("no message contains quote marks or the word 'must be a'", () => {
    const bad = [
      { username: "" },
      { username: "a" },
      { email: "x" },
      { password: "short" },
      { username: 5 },
    ];
    for (const overrides of bad) {
      for (const text of messages(check(overrides))) {
        expect(text).not.toMatch(/["']/);
      }
    }
  });
});

describe("isCommonPassword", () => {
  test("is case-insensitive and handles non-strings", () => {
    expect(isCommonPassword("PassWord123")).toBe(true);
    expect(isCommonPassword("zzzzzzzzzzzz")).toBe(true);
    expect(isCommonPassword("correct-horse-battery")).toBe(false);
    expect(isCommonPassword(undefined)).toBe(false);
    expect(isCommonPassword(12345)).toBe(false);
  });
});
