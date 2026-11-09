// A small SMTP client for the "smtp" email transport (ADR-012 follow-up).
// Node's own `net` and `tls`: no new dependency, so `package-lock.json` does
// not change.
//
//   sendMail({ host, port, secure, user, pass }, { from, to, subject, text, html?, headers? })
//
//   secure: true   TLS from the first byte (port 465; Gmail's default here)
//   secure: false  plain connect, then STARTTLS when the server offers it
//                  (port 587). A login is NEVER sent without TLS.
//
// Login uses AUTH PLAIN or AUTH LOGIN (whichever the server lists). One
// message, one recipient, per connection: Dimora sends a few emails an hour.
//
// A failure throws SmtpError with a short safe message: never the password, the
// user name or the server's reply text, only the numeric code.
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 15000;
const EHLO_NAME = "[127.0.0.1]";

class SmtpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SmtpError";
    if (code !== undefined) this.code = code;
  }
}

// ---- message ---------------------------------------------------------------

const ASCII = /^[\x20-\x7e]*$/;

/** RFC 2047 encoded words, split on character boundaries (<= 45 bytes each). */
function encodeWords(value) {
  if (ASCII.test(value)) return value;
  const words = [];
  let current = "";
  for (const ch of Array.from(value)) {
    if (Buffer.byteLength(current + ch, "utf8") > 45) {
      words.push(current);
      current = "";
    }
    current += ch;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** "Name <a@b>" or "a@b" -> { address, display } */
function parseAddress(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) throw new SmtpError("invalid sender address");
  const named = /^\s*(.*?)\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(value);
  if (named) return { address: named[2], display: named[1].replace(/^"(.*)"$/, "$1") };
  const bare = /^\s*([^<>\s@]+@[^<>\s@]+)\s*$/.exec(value);
  if (bare) return { address: bare[1], display: "" };
  throw new SmtpError("invalid sender address");
}

const wrap76 = (b64) => b64.replace(/(.{76})/g, "$1\r\n");
const base64Body = (text) => wrap76(Buffer.from(text, "utf8").toString("base64")).replace(/\r\n$/, "");

function buildMessage({ from, to, subject, text, html, headers }, { now = new Date() } = {}) {
  const sender = parseAddress(from);
  const domain = sender.address.split("@")[1];
  const fromHeader = sender.display
    ? `${ASCII.test(sender.display) ? sender.display.replace(/[\\"]/g, "") : encodeWords(sender.display)} <${sender.address}>`
    : sender.address;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeWords(subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${encodeWords(v)}`);

  let body;
  if (html) {
    const boundary = `dimora-${crypto.randomBytes(12).toString("hex")}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(text),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(html),
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    lines.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64");
    body = base64Body(text);
  }
  return { envelopeFrom: sender.address, data: `${lines.join("\r\n")}\r\n\r\n${body}` };
}

/** Dot-stuffs the message and ends it with <CRLF>.<CRLF>. */
const toDataBlock = (data) => `${data.replace(/\r?\n\./g, "\r\n..").replace(/^\./, "..")}\r\n.\r\n`;

// ---- connection ------------------------------------------------------------

/** Reads multi-line replies ("250-..." then "250 ...") from one socket. */
function replyReader(socket) {
  let buffer = "";
  let current = [];
  const replies = [];
  let waiter = null;
  let failure = null;

  const settle = () => {
    if (!waiter) return;
    if (replies.length) {
      const w = waiter;
      waiter = null;
      w.resolve(replies.shift());
    } else if (failure) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    let m;
    while ((m = /\r?\n/.exec(buffer))) {
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      current.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines: current });
        current = [];
      }
    }
    settle();
  });
  const fail = (err) => {
    failure = failure || err;
    settle();
  };
  socket.on("error", () => fail(new SmtpError("could not reach the mail server")));
  socket.on("timeout", () => {
    fail(new SmtpError("the mail server timed out"));
    socket.destroy();
  });
  socket.on("close", () => fail(new SmtpError("the mail server closed the connection")));

  return {
    read() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        settle();
      });
    },
  };
}

function connect({ host, port, secure, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, ...tlsOptions })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    const onError = () =>
      reject(new SmtpError(secure ? "could not make a TLS connection to the mail server" : "could not reach the mail server"));
    socket.once("error", onError);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new SmtpError("the mail server timed out"));
    });
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

function upgrade(socket, { host, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host, ...tlsOptions });
    secured.setTimeout(timeoutMs);
    secured.once("error", () => reject(new SmtpError("the TLS handshake with the mail server failed")));
    secured.once("secureConnect", () => resolve(secured));
  });
}

const LOGIN_CODES = new Set([530, 534, 535]);

/**
 * @param {{ host: string, port: number, secure?: boolean, user?: string, pass?: string,
 *   timeoutMs?: number, tlsOptions?: object, allowInsecureAuth?: boolean }} options
 * @param {{ from: string, to: string, subject: string, text: string, html?: string, headers?: object }} message
 * @returns {Promise<true>}
 * @throws {SmtpError}
 */
async function sendMail(options, message) {
  const {
    host,
    port,
    secure = false,
    user,
    pass,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tlsOptions = {},
    allowInsecureAuth = false,
  } = options || {};
  if (!host || !Number.isInteger(port)) throw new SmtpError("the mail server is not configured");
  const { envelopeFrom, data } = buildMessage(message);

  let socket = await connect({ host, port, secure, timeoutMs, tlsOptions });
  try {
    let reader = replyReader(socket);
    const send = (line) => socket.write(`${line}\r\n`);
    const expect = async (codes, what) => {
      const reply = await reader.read();
      if (!codes.includes(reply.code)) {
        if (what === "login" && LOGIN_CODES.has(reply.code)) {
          throw new SmtpError(
            `the mail server refused the login (${reply.code}): check SMTP_USER and the app password`,
            reply.code,
          );
        }
        throw new SmtpError(`the mail server answered ${reply.code}`, reply.code);
      }
      return reply;
    };

    await expect([220]);
    send(`EHLO ${EHLO_NAME}`);
    let caps = (await expect([250])).lines.map((l) => l.slice(4).toUpperCase());

    if (!secure) {
      if (caps.includes("STARTTLS")) {
        send("STARTTLS");
        await expect([220]);
        socket = await upgrade(socket, { host, timeoutMs, tlsOptions });
        reader = replyReader(socket);
        send(`EHLO ${EHLO_NAME}`);
        caps = (await expect([250])).lines.map((l) => l.slice(4).toUpperCase());
      } else if (user && !allowInsecureAuth) {
        throw new SmtpError("the mail server does not offer TLS, so the password was not sent");
      }
    }

    if (user) {
      const auth = caps.find((c) => c.startsWith("AUTH ")) || "";
      if (/\bPLAIN\b/.test(auth)) {
        send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass || ""}`, "utf8").toString("base64")}`);
        await expect([235], "login");
      } else if (/\bLOGIN\b/.test(auth)) {
        send("AUTH LOGIN");
        await expect([334], "login");
        send(Buffer.from(user, "utf8").toString("base64"));
        await expect([334], "login");
        send(Buffer.from(pass || "", "utf8").toString("base64"));
        await expect([235], "login");
      } else {
        throw new SmtpError("the mail server offers no supported login method");
      }
    }

    send(`MAIL FROM:<${envelopeFrom}>`);
    await expect([250]);
    send(`RCPT TO:<${message.to}>`);
    await expect([250, 251]);
    send("DATA");
    await expect([354]);
    socket.write(toDataBlock(data));
    await expect([250]);
    send("QUIT");
    return true;
  } finally {
    socket.destroy();
  }
}

module.exports = { sendMail, buildMessage, parseAddress, encodeWords, SmtpError };
