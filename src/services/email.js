// Sending email (P02-T05). One function, `send({ to, subject, text, html })`,
// over three transports:
//
//   console  writes the message to the log (development and tests). In
//            production it logs only the recipient and subject: a link in a log
//            is a password-reset key in a log.
//   resend   Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email).
//            HTTPS, not SMTP, because Render's free plan blocks SMTP ports.
//   memory   keeps the messages in an array (`service.outbox`) for tests.
//
// A failed send throws EmailError with a short, safe message: never the API
// key, the address or the provider's reply.
const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

class EmailError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmailError";
  }
}

function checkMessage({ to, subject, text }) {
  if (typeof to !== "string" || !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(to)) {
    throw new EmailError("invalid recipient");
  }
  if (typeof subject !== "string" || !subject || /[\r\n]/.test(subject)) {
    throw new EmailError("invalid subject");
  }
  if (typeof text !== "string" || !text) throw new EmailError("empty message");
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
 * @param {{ transport?: string, from?: string, resendApiKey?: string|null }} [options.email]  config.email
 * @param {boolean} [options.isProduction]
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {typeof fetch} [options.fetchImpl]
 */
function createEmailService({
  email = {},
  isProduction = false,
  logger = {},
  fetchImpl = globalThis.fetch,
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
