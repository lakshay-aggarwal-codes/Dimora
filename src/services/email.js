// Sending email (P02-T05). One function, `send({ to, subject, text, html })`,
// over four transports:
//
//   console  writes the message to the log (development and tests). In
//            production it logs only the recipient and subject: a link in a log
//            is a password-reset key in a log.
//   resend   Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email).
//            HTTPS, not SMTP, because Render's free plan blocks SMTP ports.
//   smtp     any SMTP server, for example Gmail (smtp.gmail.com:465 with an app
//            password), through the built-in client in smtpClient.js (no
//            dependency). For a computer where outbound SMTP is open: Render's
//            free plan blocks the SMTP ports, use resend there.
//   memory   keeps the messages in an array (`service.outbox`) for tests.
//
// A failed send throws EmailError with a short, safe message: never the API
// key, the address or the provider's reply.
const { sendMail, SmtpError } = require("./smtpClient");

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

class EmailError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmailError";
  }
}

function checkMessage({ to, subject, text, headers }) {
  if (typeof to !== "string" || !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(to)) {
    throw new EmailError("invalid recipient");
  }
  if (typeof subject !== "string" || !subject || /[\r\n]/.test(subject)) {
    throw new EmailError("invalid subject");
  }
  if (typeof text !== "string" || !text) throw new EmailError("empty message");
  if (headers !== undefined) {
    const ok =
      headers && typeof headers === "object" && !Array.isArray(headers) &&
      Object.entries(headers).every(
        ([k, v]) => /^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(k) && typeof v === "string" && !/[\r\n]/.test(v),
      );
    if (!ok) throw new EmailError("invalid headers");
  }
}

function createMemoryEmailService() {
  const outbox = [];
  return {
    transport: "memory",
    outbox,
    async send(message) {
      checkMessage(message);
      outbox.push({ ...message });
    },
  };
}

/**
 * @param {object} options
 * @param {{ transport?: string, from?: string, resendApiKey?: string|null,
 *   smtp?: { host?: string, port?: number, secure?: boolean, user?: string, pass?: string } }} [options.email]  config.email
 * @param {boolean} [options.isProduction]
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof sendMail} [options.smtpSend]  replaced in tests
 */
function createEmailService({
  email = {},
  isProduction = false,
  logger = {},
  fetchImpl = globalThis.fetch,
  smtpSend = sendMail,
} = {}) {
  const transport = email.transport || "console";
  const from = email.from || "Dimora <no-reply@localhost>";

  if (transport === "resend") {
    return {
      transport,
      async send(message) {
        checkMessage(message);
        let res;
        try {
          res = await fetchImpl(RESEND_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${email.resendApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
              ...(message.html ? { html: message.html } : {}),
              ...(message.headers ? { headers: message.headers } : {}),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (err) {
          throw new EmailError(
            err && err.name === "TimeoutError" ? "the email provider timed out" : "could not reach the email provider",
          );
        }
        if (!res.ok) throw new EmailError(`the email provider answered ${res.status}`);
      },
    };
  }

  if (transport === "smtp") {
    const smtp = email.smtp || {};
    return {
      transport,
      async send(message) {
        checkMessage(message);
        try {
          await smtpSend(
            { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass },
            { from, ...message },
          );
        } catch (err) {
          // SmtpError messages are short and safe (no password, no server text).
          throw new EmailError(err instanceof SmtpError ? err.message : "could not send through the mail server");
        }
      },
    };
  }

  return {
    transport: "console",
    async send(message) {
      checkMessage(message);
      if (isProduction) {
        if (logger.warn) logger.warn({ subject: message.subject }, "email not sent: no email provider is configured");
        return;
      }
      if (logger.info) {
        logger.info(
          { email: { to: message.to, subject: message.subject, text: message.text } },
          "email (console transport, not sent)",
        );
      }
    },
  };
}

module.exports = { createEmailService, createMemoryEmailService, EmailError, RESEND_URL };
