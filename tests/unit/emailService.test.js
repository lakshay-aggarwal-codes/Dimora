// P02-T05: the email transports.
const assert = require("node:assert/strict");
const {
  createEmailService,
  createMemoryEmailService,
  EmailError,
  RESEND_URL,
} = require("../../src/services/email");

const MESSAGE = { to: "ann@example.com", subject: "Hello", text: "Body with https://x.test/reset/abc", html: "<p>Hi</p>" };

function logs() {
  const lines = [];
  return { lines, info: (o, m) => lines.push({ level: "info", o, m }), warn: (o, m) => lines.push({ level: "warn", o, m }) };
}

test("console transport logs the whole message in development", async () => {
  const logger = logs();
  await createEmailService({ email: { transport: "console" }, logger }).send(MESSAGE);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].o.email.to, "ann@example.com");
  assert.ok(logger.lines[0].o.email.text.includes("https://x.test/reset/abc"));
});

test("console transport in production logs the subject only, never the link", async () => {
  const logger = logs();
  await createEmailService({ email: { transport: "console" }, isProduction: true, logger }).send(MESSAGE);
  const written = JSON.stringify(logger.lines);
  assert.equal(written.includes("x.test"), false);
  assert.equal(written.includes("ann@example.com"), false);
  assert.ok(written.includes("Hello"));
});

test("resend transport posts JSON with the key, sender and recipient", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 });
  const svc = createEmailService({
    email: { transport: "resend", from: "Dimora <hi@example.com>", resendApiKey: "re_key_123" },
    fetchImpl,
  });
  await svc.send(MESSAGE);
  assert.equal(calls[0].url, RESEND_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_key_123");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, "Dimora <hi@example.com>");
  assert.deepEqual(body.to, ["ann@example.com"]);
  assert.equal(body.subject, "Hello");
  assert.equal(body.text, MESSAGE.text);
});

test("a provider error becomes a short EmailError without the key or the address", async () => {
  const svc = createEmailService({
    email: { transport: "resend", resendApiKey: "re_secret_key" },
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => "bad key re_secret_key ann@example.com" }),
  });
  await assert.rejects(
    () => svc.send(MESSAGE),
    (err) => err instanceof EmailError && /403/.test(err.message) && !/re_secret_key|ann@/.test(err.message),
  );
});

test("a network failure or timeout becomes an EmailError", async () => {
  const down = createEmailService({
    email: { transport: "resend", resendApiKey: "k" },
    fetchImpl: async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED re_key");
    },
  });
  await assert.rejects(() => down.send(MESSAGE), (e) => e instanceof EmailError && !/ECONNREFUSED|re_key/.test(e.message));
  const slow = createEmailService({
    email: { transport: "resend", resendApiKey: "k" },
    fetchImpl: async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    },
  });
  await assert.rejects(() => slow.send(MESSAGE), /timed out/);
});

test("bad recipients, subjects with line breaks and empty bodies are refused before sending", async () => {
  let sent = 0;
  const svc = createEmailService({ email: { transport: "resend", resendApiKey: "k" }, fetchImpl: async () => (sent++, { ok: true }) });
  for (const bad of [
    { ...MESSAGE, to: "not-an-address" },
    { ...MESSAGE, to: "a@b.com, c@d.com" },
    { ...MESSAGE, to: "a@b.com\nBcc: x@y.com" },
    { ...MESSAGE, subject: "Hi\nBcc: x@y.com" },
    { ...MESSAGE, subject: "" },
    { ...MESSAGE, text: "" },
  ]) {
    await assert.rejects(() => svc.send(bad), EmailError);
  }
  assert.equal(sent, 0);
});

test("the memory transport keeps what was sent", async () => {
  const svc = createMemoryEmailService();
  await svc.send(MESSAGE);
  assert.equal(svc.outbox.length, 1);
  assert.equal(svc.outbox[0].to, "ann@example.com");
});
