// A short list of passwords that are common and still long enough to pass the
// 10-character minimum. Compared in lower case. This is a speed bump, not a
// breach database: it stops the obvious choices.
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "12345678910",
  "123456789012",
  "0123456789",
  "9876543210",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "qwertyuiop",
  "qwertyuiop123",
  "qwerty12345",
  "qwerty123456",
  "asdfghjkl",
  "asdfghjkl123",
  "zxcvbnm123",
  "password12",
  "password123",
  "password1234",
  "password12345",
  "password123456",
  "passw0rd123",
  "p@ssw0rd123",
  "p@ssword123",
  "iloveyou12",
  "iloveyou123",
  "letmein1234",
  "letmein12345",
  "welcome123",
  "welcome1234",
  "welcome12345",
  "admin12345",
  "admin123456",
  "administrator",
  "abc1234567",
  "abcd123456",
  "abcdefghij",
  "abcdefghijk",
  "trustno1234",
  "football123",
  "baseball123",
  "superman123",
  "princess123",
  "sunshine123",
  "monkey12345",
  "dragon12345",
  "master12345",
  "changeme123",
  "changemenow",
  "internet123",
  "computer123",
  "samsung1234",
  "india12345",
  "india123456",
  "dimora12345",
  "dimora123456",
]);

/** True for a listed password or one made of a single repeated character. */
function isCommonPassword(password) {
  if (typeof password !== "string") return false;
  const lower = password.toLowerCase();
  return COMMON_PASSWORDS.has(lower) || /^(.)\1+$/s.test(lower);
}

module.exports = { COMMON_PASSWORDS, isCommonPassword };
