# Email, address confirmation and password reset (P02-T05)

## What it does

| Flow | Pages | Rule |
|---|---|---|
| Confirm the address | `GET /verify-email/:token` (button), `POST /verify-email`, `GET /verify-email/needed`, `POST /verify-email/resend` | Link valid 24 h, works once. Sent at signup and on request (one a minute, five an hour per account). Opening the link only shows a button; the POST uses it, so a mail scanner that opens links cannot burn it. |
| Forgot / reset password | `GET/POST /forgot-password`, `GET /reset-password/:token`, `POST /reset-password` | Link valid 1 h, works once. The answer to "forgot password" is the same for every address. A weak password sent to the form does not use the link up. A "your password was changed" note is sent. |
| The gate | publishing a listing (`POST /host/listings/:id/publish`) and booking (`GET/POST /listings/:id/checkout`) | Needs a confirmed address, checked on the server (`ensureVerifiedEmail`). Browsing, saving, messaging and editing drafts do not. |

Tokens: 32 random bytes (base64url). Only the SHA-256 hash is stored (`EmailToken`), with the address the link was sent to; a link for an address the account no longer has confirms nothing. A new link cancels the older unused ones. Used rows are removed a week after expiry.

A successful reset also confirms the address (the link was read there) and lifts the failed-login lock (P02-T02).

## Settings

| Key | Default | Meaning |
|---|---|---|
| `EMAIL_TRANSPORT` | `console` | `console` writes the message to the server log (development: the link is in your terminal; in production only the subject is logged, never the link). `resend` sends through Resend's HTTPS API. |
| `EMAIL_FROM` | `Dimora <no-reply@localhost>` | Required with `resend`: an address on a domain verified at Resend. |
| `RESEND_API_KEY` | none | Required with `resend`. Secret. |
| `EMAIL_VERIFICATION_REQUIRED` | `true` | `false`: nothing asks for a confirmed address (for a deployment that cannot send email). Signup then sends no email either. |

## Choice of provider (ADR-012)

Roadmap suggested Nodemailer with Ethereal for development. Changed, for two reasons:

- Render's free web service blocks outbound SMTP ports 25, 465 and 587 (docs/DEPLOYMENT.md), so SMTP cannot work on the chosen host. An HTTPS API can.
- Nodemailer would be a new dependency, and this task was built where `package-lock.json` could not be regenerated. The HTTPS call uses Node's built-in `fetch`: no new dependency, no lockfile change.

**Resend, free plan (read 2026-10-28, https://resend.com/docs/knowledge-base/what-is-resend-pricing):** 3,000 emails a month, **100 a day** (sending pauses at the limit), 1 domain. Every address in To/CC/BCC counts as one email. Resend asks you to verify your own sending domain before you send to other people: **without a domain of your own, real signups cannot receive mail.** For a demo with no domain, run with `EMAIL_TRANSPORT=console` and `EMAIL_VERIFICATION_REQUIRED=false`, and give the demo accounts' passwords on the demonstration sheet.

Other providers with an HTTPS API can be added as another transport in `src/services/email.js` (about 30 lines); they were not compared.

## Limits that remain

- Other signed-in sessions of an account stay valid after a reset (as after a password change in P02-T04). The session identifies the member by username.
- "Forgot password" answers the same text, but a known address takes a little longer (a database write and a mail call): a patient attacker could measure it. Rate limits (10 an hour per IP, 5 an hour per account) slow that down; they do not remove it.
- Accounts created before this task are unconfirmed. With the default setting they must confirm before publishing or booking (log in, `/verify-email/needed`). `EMAIL_VERIFICATION_REQUIRED=false` avoids it.
- Changing the email address is not a feature yet; when it is added it must clear `emailVerifiedAt` and send a new link.
- Delivery (spam folders, SPF/DKIM) depends on the domain set-up at the provider and was not tested.
- Nothing here was run against Resend, and the database tests could not be run where this was written.

## Trying it locally

```powershell
npm run dev
# Sign up at http://localhost:8080/signup, then read the line "email (console transport, not sent)"
# in the terminal: it contains the link. Open it, press the button.
```
