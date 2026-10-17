// P02-T03: what the "edit my profile" form accepts (no database).
const { validateProfile } = require("../../src/validation/profile");

const bad = (body) => Object.keys(validateProfile(body).errors);

test("valid input is trimmed; empty fields get empty strings and no avatar removal", () => {
  const { value, errors } = validateProfile({ displayName: "  Asha K  ", bio: "  Hello  " });
  expect(errors).toEqual({});
  expect(value).toEqual({ displayName: "Asha K", bio: "Hello", removeAvatar: false });
  expect(validateProfile({}).value).toEqual({ displayName: "", bio: "", removeAvatar: false });
  expect(validateProfile(undefined).value.displayName).toBe("");
});

test("display name: at most 60 characters, no control characters", () => {
  expect(bad({ displayName: "x".repeat(61) })).toEqual(["displayName"]);
  expect(bad({ displayName: "x".repeat(60) })).toEqual([]);
  expect(bad({ displayName: "bad\u0000name" })).toEqual(["displayName"]);
  expect(bad({ displayName: "two\nlines" })).toEqual(["displayName"]);
  expect(validateProfile({ displayName: "x".repeat(61) }).errors.displayName).toMatch(
    /60 characters or fewer/,
  );
});

test("bio: at most 500 characters; line breaks are kept and normalised; other control characters are refused", () => {
  expect(bad({ bio: "x".repeat(501) })).toEqual(["bio"]);
  expect(bad({ bio: "x".repeat(500) })).toEqual([]);
  expect(validateProfile({ bio: "one\r\ntwo\rthree\nfour" }).value.bio).toBe("one\ntwo\nthree\nfour");
  expect(bad({ bio: "bell\u0007" })).toEqual(["bio"]);
});

test("the remove-photo checkbox understands the browser's values", () => {
  expect(validateProfile({ removeAvatar: "on" }).value.removeAvatar).toBe(true);
  expect(validateProfile({ removeAvatar: "1" }).value.removeAvatar).toBe(true);
  expect(validateProfile({}).value.removeAvatar).toBe(false);
  expect(bad({ removeAvatar: "maybe" })).toEqual(["removeAvatar"]);
});

test("any other field is refused, so the form cannot change an id, role, email or status", () => {
  for (const field of ["email", "role", "status", "id", "_id", "username", "avatar", "emailVerifiedAt"]) {
    expect(bad({ displayName: "Asha", [field]: "x" })).toEqual([field]);
  }
});
