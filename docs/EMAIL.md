# Email, address confirmation and password reset (P02-T05)

## What it does

| Flow | Pages | Rule |
|---|---|---|
| Confirm the address | `GET /verify-email/:token` (button), `POST /verify-email`, `GET /verify-email/needed`, `POST /verify-email/resend` | Link valid 24 h, works once. Sent at signup and on request (one a minute, five an hour per account). Opening the link only shows a button; the POST uses it, so a mail scanner that opens links cannot burn it. |
| Forgot / reset password | `GET/POST /forgot-password`, `GET /reset-password/:token`, `POST /reset-password` | Link valid 1 h, works once. The answer to "forgot password" is the same for every address. A weak password sent to the form does not use the link up. A "your password was changed" note is sent. |
| The gate | publishing a listing (`POST /host/listings/:id/publish`) and booking (`GET/POST /listings/:id/checkout`) | Needs a confirmed address, checked on the server (`ensureVerifiedEmail`). Browsing, saving, messaging and editing drafts do not. |

Tokens: 32 random bytes (base64url). Only the SHA-256 hash is stored (`EmailToken`), with the address the link was sent to; a link for an address the account no longer has confirms nothing. A new link cancels the older unused ones. Used rows are removed a week after expiry.

A successful reset also confirms the address (the link was read there) and lifts the failed-login lock (P02-T02).

## Notification emails and preferences (P11-T05)

Every in-app notification (P11-T04) can also be emailed. **In-app is always on**; only the email copy has switches (`/account/notifications`, linked from Account settings).

| Group | Notifications | Switch |
|---|---|---|
| Bookings | requested, booked, changed dates, accepted, declined, expired, cancelled | on by default, can be turned off |
| Reminders | check-in tomorrow | on by default, can be turned off |
| Reviews | review available | on by default, can be turned off |
| Decisions about your listings | listing suspended / restored | **always on** (about something the member runs); no stop link |

Rules (`src/services/notificationEmail.js`, groups in `src/config/notificationPrefs.js`):
- The email is sent only to an **active account with a confirmed address** (`emailVerifiedAt`). Nothing is sent to an unconfirmed address, even if the preference is on.
- It is a copy of a notification that was **stored**; sending runs in the background and a failure is logged (no address, no link) and never affects the booking or admin action.
- Every optional email has a **"stop these emails"** link and a `List-Unsubscribe` header. The link carries a signed token (HMAC-SHA256 of member + group, keyed from `SESSION_SECRET`; no database row). Opening it only shows a button; the POST switches that group off. Changing `SESSION_SECRET` invalidates old links (the member can still use the settings page). Not implemented: one-click `List-Unsubscribe-Post` (the app-wide CSRF check would refuse a mail provider's POST).
- Choices are stored on the member (`User.notificationEmail.{bookings,reminders,reviews}`); unset = the group default. Account deletion removes them with the account.
- Messages carry the title, the text and a link back to the site: nothing the member could not already read in the app. Texts are escaped in the HTML part.

Volume: the free Resend plan allows 100 emails a day (see below). There is no counter in the app: past the limit sending fails, is logged, and the in-app notification still exists. With `EMAIL_TRANSPORT=console` nothing is delivered (development: the message is in the log).

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
