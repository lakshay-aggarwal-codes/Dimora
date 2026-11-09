# SMTP transport (Gmail) - outside the Q-queue

Date: 2026-11-08 - New dependencies: none (Node's `net` and `tls`; `package-lock.json` unchanged) - Migration: none.

Why: with the default `EMAIL_TRANSPORT=console` nothing reaches a real inbox (the link is printed in the server terminal), and Resend needs a verified domain. This adds `EMAIL_TRANSPORT=smtp` so mail can go out through a Gmail account with an app password. ADR-012 chose an HTTPS API because Render's free plan blocks SMTP and Nodemailer would have changed the lockfile; both still hold, so `resend` stays the choice for that host, and `smtp` is for a computer where SMTP is open (including the owner's).

## Files
Added: `src/services/smtpClient.js` (EHLO, STARTTLS, AUTH PLAIN / LOGIN, MAIL, RCPT, DATA; UTF-8 subjects as encoded words; text and HTML parts as base64 multipart/alternative; dot-stuffing; timeouts), tests `tests/unit/smtpClient.test.js`, `emailService.smtp.test.js`, `env.smtp.test.js`.
Changed: `src/services/email.js` (fourth transport), `src/config/env.js` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`; `EMAIL_TRANSPORT` accepts `smtp`; required-key checks; production warning; `config.email.smtp`; `from` defaults to `Dimora <SMTP_USER>`; spaces removed from a Gmail app password), `src/config/logger.js` (redacts `*.smtp.pass`), `README.md` (env rows), `.env.example`, `docs/EMAIL.md` (settings and a "Sending through Gmail" section).

## Safety decisions
- A login is never sent without TLS: port 465 is TLS from the first byte; otherwise the client requires STARTTLS and refuses a server that does not offer it. The server certificate is checked (an untrusted certificate is refused).
- Errors are short and safe: the numeric code only, never the password, the user name, the address or the server's reply text. `EmailError` messages come only from `SmtpError`; anything else becomes "could not send through the mail server".
- The sender and recipient are checked for line breaks (no header injection); the subject and extra headers were already checked by `checkMessage`.

## Tests
- `node --check` on every changed file; secret scanner over the project: clean; README env rows, `KEYS` and `.env.example` agree.
- Not Jest (no `node_modules` here): `smtpClient.test.js` (14) and `emailService.smtp.test.js` (4) and `emailService.test.js` (8) were run with a small stand-in runner and pass. The fake server is a scripted TCP server on localhost. `env.smtp.test.js` needs Joi and was **not executed**; lint was not run.
- TLS on 465 and STARTTLS on 587 were checked by hand against a throwaway certificate (not committed): the login travelled only over TLS in both, and an untrusted certificate was refused by default. They are not automated tests (a certificate in the repo would be a key in the repo).
- **Not tested against Gmail itself.**

## Owner steps
1. Google account > Security: turn on 2-Step Verification, then App passwords: create one (16 letters).
2. In `.env`: `EMAIL_TRANSPORT=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<the app password>`; restart `npm run dev`.
3. Open `/verify-email/needed`, press "Send the link again": the mail arrives in that Gmail (Spam the first time). If the terminal says `refused the login (535)`, the app password or the user name is wrong; if `could not make a TLS connection`, a firewall or antivirus is intercepting port 465 (try `SMTP_PORT=587`).

## Limits
Gmail allows about 500 messages a day for a normal account; there is no counter. One message per connection. The sender shown is the Gmail account whatever `EMAIL_FROM` says. SPF/DKIM for another domain is not handled.
