// P02-T04: the change-password and delete-account forms' rules.
const {
  changePasswordSchema,
  deleteAccountSchema,
  signupSchema,
} = require("../../src/validation");

const ctx = { context: { username: "ann_lee", email: "ann.lee@example.com" } };
const messages = (schema, body, options = ctx) => {
  const { error } = schema.validate(body, {
    abortEarly: false,
    stripUnknown: true,
    errors: { wrap: { label: false } },
    ...options,
  });
  return error ? [...new Set(error.details.map((d) => d.message))] : [];
};
const good = {
  currentPassword: "old-Password-1",
  newPassword: "A-better-passphrase-9",
  confirmPassword: "A-better-passphrase-9",
};

describe("changePasswordSchema", () => {
  test("a good change", () =>
    expect(messages(changePasswordSchema, good)).toEqual([]));

  test("the same rules as signup: length, common passwords, username and email name", () => {
    const body = (newPassword) => ({
      ...good,
      newPassword,
      confirmPassword: newPassword,
    });
    expect(messages(changePasswordSchema, body("short1"))).toEqual([
      "Password must be at least 10 characters.",
    ]);
    expect(messages(changePasswordSchema, body("x".repeat(129)))).toEqual([
      "Password must be at most 128 characters.",
    ]);
    expect(messages(changePasswordSchema, body("password123"))).toEqual([
      "That password is too common. Choose a less predictable one.",
    ]);
    expect(
      messages(changePasswordSchema, body("ann_lee"), {
        context: { username: "ann_lee", email: "x@y.zz" },
      })[0],
    ).toMatch(/at least 10|must not be the same/);
    expect(
      messages(changePasswordSchema, body("ANN.LEE.ANN"), {
        context: { username: "u", email: "ann.lee.ann@example.com" },
      }),
    ).toEqual(["Password must not be the same as your username or email."]);
  });

  test("the confirmation must match", () => {
    expect(
      messages(changePasswordSchema, {
        ...good,
        confirmPassword: "Something-else-123",
      }),
    ).toEqual(["The two new passwords do not match."]);
    expect(
      messages(changePasswordSchema, { ...good, confirmPassword: "" }),
    ).toEqual(["Type the new password again to confirm it."]);
    const { confirmPassword, ...missing } = good;
    expect(confirmPassword).toBeDefined();
    expect(messages(changePasswordSchema, missing)).toEqual([
      "Type the new password again to confirm it.",
    ]);
  });

  test("the new password must differ from the current one", () => {
    const same = {
      currentPassword: "Same-Password-123",
      newPassword: "Same-Password-123",
      confirmPassword: "Same-Password-123",
    };
    expect(messages(changePasswordSchema, same)).toEqual([
      "The new password must be different from the current one.",
    ]);
  });

  test("the current password is required but its strength is not judged", () => {
    expect(
      messages(changePasswordSchema, { ...good, currentPassword: "" }),
    ).toEqual(["Enter your current password."]);
    expect(
      messages(changePasswordSchema, { ...good, currentPassword: undefined }),
    ).toEqual(["Enter your current password."]);
    expect(
      messages(changePasswordSchema, { ...good, currentPassword: "abc" }),
    ).toEqual([]); // an old, weak password can still be changed
  });

  test.each([[null], [5], [["a"]], [{ $ne: 1 }]])(
    "a non-text password %j is refused",
    (bad) => {
      expect(
        messages(changePasswordSchema, {
          ...good,
          newPassword: bad,
          confirmPassword: bad,
        }).length,
      ).toBeGreaterThan(0);
      expect(
        messages(changePasswordSchema, { ...good, currentPassword: bad })
          .length,
      ).toBeGreaterThan(0);
    },
  );

  test("unknown fields (a role, a status) are dropped, not accepted", () => {
    const { value } = changePasswordSchema.validate(
      { ...good, role: "admin", status: "active" },
      { stripUnknown: true, ...ctx },
    );
    expect(Object.keys(value).sort()).toEqual([
      "confirmPassword",
      "currentPassword",
      "newPassword",
    ]);
  });

  test("signup still behaves the same after the shared rule", () => {
    const base = { username: "ann_lee", email: "ann@example.com" };
    const check = (password) =>
      messages(signupSchema, { ...base, password }, {});
    expect(check("A-better-passphrase-9")).toEqual([]);
    expect(check("password123")).toEqual([
      "That password is too common. Choose a less predictable one.",
    ]);
    expect(check("short")).toEqual([
      "Password must be at least 10 characters.",
    ]);
    expect(check("ann_lee_ann")).toEqual([]); // not equal to the username: allowed
    expect(
      messages(
        signupSchema,
        { ...base, username: "annannannann", password: "annannannann" },
        {},
      ),
    ).toEqual(["Password must not be the same as your username or email."]);
  });
});

describe("deleteAccountSchema", () => {
  test("the password and the word DELETE", () => {
    expect(
      messages(deleteAccountSchema, { password: "x", confirm: "DELETE" }, {}),
    ).toEqual([]);
    expect(
      messages(deleteAccountSchema, { password: "x", confirm: " DELETE " }, {}),
    ).toEqual([]);
  });
  test.each([[""], ["delete"], ["Delete"], ["DELETE ME"], [undefined], [5]])(
    "a confirmation of %j is refused",
    (confirm) => {
      expect(
        messages(deleteAccountSchema, { password: "x", confirm }, {}),
      ).toEqual(["Type DELETE to confirm."]);
    },
  );
  test("no password is refused", () => {
    expect(messages(deleteAccountSchema, { confirm: "DELETE" }, {})).toEqual([
      "Enter your password to delete your account.",
    ]);
    expect(
      messages(deleteAccountSchema, { password: "", confirm: "DELETE" }, {}),
    ).toEqual(["Enter your password to delete your account."]);
  });
});
