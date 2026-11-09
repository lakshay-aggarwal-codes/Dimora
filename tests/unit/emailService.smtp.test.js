// The smtp transport of the email service (the client itself is smtpClient.test.js).
const assert = require("node:assert/strict");
const { createEmailService, EmailError } = require("../../src/services/email");
const { SmtpError } = require("../../src/services/smtpClient");

const MESSAGE = { to: "ann@example.com", subject: "Hello", text: "Body with https://x.test/verify-email/abc", html: "<p>Hi</p>" };
const EMAIL = {
  transport: "smtp",
  from: "Dimora <dimora.test@gmail.com>",
  smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "dimora.test@gmail.com", pass: "s3cretpass" },
};

test("the transport is named smtp and hands the server settings and the whole message to the client", async () => {
  const calls = [];
  const service = createEmailService({ email: EMAIL, smtpSend: async (options, message) => calls.push({ options, message }) });
  assert.equal(service.transport, "smtp");
  await service.send({ ...MESSAGE, headers: { "List-Unsubscribe": "<https://x.test/stop>" } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { host: "smtp.gmail.com", port: 465, secure: true, user: "dimora.test@gmail.com", pass: "s3cretpass" });
  assert.equal(calls[0].message.from, "Dimora <dimora.test@gmail.com>");
  assert.equal(calls[0].message.to, "ann@example.com");
  assert.equal(calls[0].message.html, "<p>Hi</p>");
  assert.equal(calls[0].message.headers["List-Unsubscribe"], "<https://x.test/stop>");
});

test("a bad message is refused before any connection", async () => {
  let called = false;
  const service = createEmailService({ email: EMAIL, smtpSend: async () => { called = true; } });
  await assert.rejects(service.send({ ...MESSAGE, to: "not an address" }), EmailError);
  await assert.rejects(service.send({ ...MESSAGE, subject: "a\r\nBcc: x@y.z" }), EmailError);
  assert.equal(called, false);
});

test("a client error becomes an EmailError with the client's safe message", async () => {
  const service = createEmailService({
    email: EMAIL,
    smtpSend: async () => { throw new SmtpError("the mail server refused the login (535): check SMTP_USER and the app password", 535); },
  });
  await assert.rejects(service.send(MESSAGE), (err) => err instanceof EmailError && /refused the login \(535\)/.test(err.message));
});

test("an unexpected error is replaced by a generic message: nothing from it, no password, no address", async () => {
  const service = createEmailService({
    email: EMAIL,
    smtpSend: async () => { throw new Error("boom s3cretpass dimora.test@gmail.com ann@example.com"); },
  });
  await assert.rejects(service.send(MESSAGE), (err) => {
    assert.ok(err instanceof EmailError);
    assert.equal(err.message, "could not send through the mail server");
    assert.equal(/s3cretpass|dimora\.test|ann@/.test(err.message), false);
    return true;
  });
});
