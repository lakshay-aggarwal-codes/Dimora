// The built-in SMTP client against a scripted fake server on localhost (plain
// TCP). The TLS paths (implicit TLS on 465, STARTTLS on 587) need a certificate
// and are not covered here; see docs/EMAIL.md for how they were checked.
const net = require("node:net");
const { sendMail, buildMessage, parseAddress, encodeWords, SmtpError } = require("../../src/services/smtpClient");

/** A scripted SMTP server. `script` can change any answer. */
function fakeServer(script = {}) {
  const log = { commands: [], data: "", auth: [] };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    const say = (text) => socket.write(`${text}\r\n`);
    say(script.greeting || "220 fake ESMTP ready");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let m;
      while ((m = /\r\n/.exec(buffer))) {
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            say(script.afterData || "250 2.0.0 queued");
          } else log.data += `${line}\r\n`;
          continue;
        }
        log.commands.push(line);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          const caps = script.caps || ["AUTH PLAIN LOGIN"];
          say(["250-fake at your service", ...caps.slice(0, -1).map((c) => `250-${c}`), `250 ${caps[caps.length - 1] || "8BITMIME"}`].join("\r\n"));
        } else if (verb === "AUTH") {
          log.auth.push(line);
          const parts = line.split(" ");
          if (parts[1].toUpperCase() === "PLAIN") say(script.authPlain || "235 2.7.0 accepted");
          else {
            log.loginSteps = true;
            say("334 VXNlcm5hbWU6");
          }
        } else if (log.loginSteps && !log.authDone) {
          log.auth.push(line);
          if (log.auth.length === 2) say("334 UGFzc3dvcmQ6");
          else {
            log.authDone = true;
            say(script.authLogin || "235 2.7.0 accepted");
          }
        } else if (verb === "MAIL") say(script.mailFrom || "250 sender ok");
        else if (verb === "RCPT") say(script.rcptTo || "250 recipient ok");
        else if (verb === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (verb === "QUIT") {
          say("221 bye");
          socket.end();
        } else say("502 not implemented");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, log, port: server.address().port }));
  });
}

const MESSAGE = {
  from: "Dimora <dimora.test@gmail.com>",
  to: "guest@example.com",
  subject: "Confirm your email",
  text: "Open this link: https://example.com/verify-email/abc123\n\n.a line that starts with a dot",
};
const decodeBody = (data) => {
  const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, "");
  return Buffer.from(body, "base64").toString("utf8");
};

let running;
afterEach(() => {
  if (running) running.server.close();
  running = null;
});
async function start(script) {
  running = await fakeServer(script);
  return running;
}
const options = (port, extra = {}) => ({
  host: "127.0.0.1",
  port,
  secure: false,
  user: "dimora.test@gmail.com",
  pass: "abcdefghijklmnop",
  allowInsecureAuth: true,
  timeoutMs: 2000,
  ...extra,
});

describe("sendMail against a fake server", () => {
  test("EHLO, AUTH PLAIN, MAIL, RCPT, DATA in order; the text arrives intact, dot-stuffed on the wire", async () => {
    const { port, log } = await start();
    await expect(sendMail(options(port), MESSAGE)).resolves.toBe(true);
    const verbs = log.commands.map((c) => c.split(" ")[0]);
    expect(verbs.slice(0, 5)).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
    expect(log.commands).toContain("MAIL FROM:<dimora.test@gmail.com>");
    expect(log.commands).toContain("RCPT TO:<guest@example.com>");
    const plain = Buffer.from(log.auth[0].split(" ")[2], "base64").toString("utf8");
    expect(plain).toBe("\0dimora.test@gmail.com\0abcdefghijklmnop");
    expect(log.data).toContain("Subject: Confirm your email");
    expect(log.data).toContain("From: Dimora <dimora.test@gmail.com>");
    expect(log.data).toContain("To: guest@example.com");
    expect(decodeBody(log.data)).toBe(MESSAGE.text);
  });

  test("AUTH LOGIN when the server does not offer PLAIN", async () => {
    const { port, log } = await start({ caps: ["AUTH LOGIN"] });
    await sendMail(options(port), MESSAGE);
    expect(log.auth[0]).toBe("AUTH LOGIN");
    expect(Buffer.from(log.auth[1], "base64").toString()).toBe("dimora.test@gmail.com");
    expect(Buffer.from(log.auth[2], "base64").toString()).toBe("abcdefghijklmnop");
  });

  test("a refused login says check the app password, with the code and nothing else from the server", async () => {
    const { port } = await start({ authPlain: "535-5.7.8 Username and Password not accepted secret-detail\r\n535 5.7.8 more" });
    const err = await sendMail(options(port), MESSAGE).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(535);
    expect(err.message).toContain("refused the login (535)");
    expect(err.message).toContain("app password");
    expect(err.message).not.toContain("secret-detail");
    expect(err.message).not.toContain("abcdefghijklmnop");
  });

  test("a refused recipient is an error with the code", async () => {
    const { port } = await start({ rcptTo: "550 5.1.1 no such user" });
    await expect(sendMail(options(port), MESSAGE)).rejects.toMatchObject({ code: 550, message: "the mail server answered 550" });
  });

  test("a server that does not offer TLS never gets the password (unless explicitly allowed)", async () => {
    const { port, log } = await start();
    await expect(sendMail(options(port, { allowInsecureAuth: false }), MESSAGE)).rejects.toThrow("password was not sent");
    expect(log.auth).toEqual([]);
  });

  test("without a user name there is no login at all", async () => {
    const { port, log } = await start();
    await sendMail({ host: "127.0.0.1", port, secure: false, timeoutMs: 2000 }, MESSAGE);
    expect(log.auth).toEqual([]);
    expect(log.commands.some((c) => c.startsWith("DATA"))).toBe(true);
  });

  test("a server that never answers times out with a safe message", async () => {
    const silent = net.createServer(() => {});
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    const err = await sendMail(options(silent.address().port, { timeoutMs: 150 }), MESSAGE).catch((e) => e);
    silent.close();
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toBe("the mail server timed out");
  });

  test("a closed port is 'could not reach'", async () => {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    await expect(sendMail(options(port), MESSAGE)).rejects.toThrow("could not reach the mail server");
  });

  test("a missing host or port is refused before connecting", async () => {
    await expect(sendMail({ host: "", port: 465 }, MESSAGE)).rejects.toBeInstanceOf(SmtpError);
    await expect(sendMail({ host: "smtp.example.com", port: "465" }, MESSAGE)).rejects.toBeInstanceOf(SmtpError);
  });
});

describe("buildMessage", () => {
  const fixed = new Date("2026-11-08T07:00:00Z");
  test("headers, a UTC date, a message id on the sender's domain, base64 text", () => {
    const { envelopeFrom, data } = buildMessage(MESSAGE, { now: fixed });
    expect(envelopeFrom).toBe("dimora.test@gmail.com");
    expect(data).toContain("Date: Sun, 08 Nov 2026 07:00:00 +0000");
    expect(data).toMatch(/Message-ID: <[0-9a-f-]{36}@gmail\.com>/);
    expect(data).toContain("MIME-Version: 1.0");
    expect(data).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(data).toContain("Content-Transfer-Encoding: base64");
    expect(decodeBody(data)).toBe(MESSAGE.text);
  });

  test("an HTML part makes it multipart/alternative with both parts", () => {
    const { data } = buildMessage({ ...MESSAGE, html: "<p>Hello <b>there</b></p>" }, { now: fixed });
    const boundary = /boundary="([^"]+)"/.exec(data)[1];
    expect(data).toContain("multipart/alternative");
    expect(data.split(`--${boundary}`).length).toBe(4); // preamble, text, html, closing
    expect(data).toContain(`--${boundary}--`);
    expect(data).toContain('Content-Type: text/html; charset="utf-8"');
  });

  test("a non-ASCII subject and display name become encoded words and round-trip", () => {
    const { data } = buildMessage({ ...MESSAGE, from: "Dimora Ghar <a@b.com>", subject: "बुकिंग की पुष्टि करें ✓" }, { now: fixed });
    const subject = /Subject: ([^\r]*(?:\r\n [^\r]*)*)/.exec(data)[1];
    const words = subject.split(/\r\n /).map((w) => /^=\?UTF-8\?B\?(.*)\?=$/.exec(w)[1]);
    expect(Buffer.from(words.join(""), "base64").toString("utf8")).toBe("बुकिंग की पुष्टि करें ✓");
    expect(encodeWords("plain ascii")).toBe("plain ascii");
    for (const w of subject.split(/\r\n /)) expect(w.length).toBeLessThanOrEqual(75);
  });

  test("extra headers (List-Unsubscribe) are written as given", () => {
    const { data } = buildMessage({ ...MESSAGE, headers: { "List-Unsubscribe": "<https://example.com/stop>" } }, { now: fixed });
    expect(data).toContain("List-Unsubscribe: <https://example.com/stop>");
  });

  test("a sender with a line break or no address is refused (no header injection)", () => {
    expect(() => parseAddress("a@b.com\r\nBcc: x@y.com")).toThrow(SmtpError);
    expect(() => parseAddress("not an address")).toThrow(SmtpError);
    expect(parseAddress("Dimora <a@b.com>")).toEqual({ address: "a@b.com", display: "Dimora" });
    expect(parseAddress("a@b.com")).toEqual({ address: "a@b.com", display: "" });
  });
});
