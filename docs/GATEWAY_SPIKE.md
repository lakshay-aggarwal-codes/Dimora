# Payment gateway test mode: feasibility spike (P16-T02)

Date: 2026-10-29 - Status: **findings and recommendation; nothing was implemented, no keys were used.**
Question: can Dimora replace the simulated payment (ADR-009) with a real gateway **in test mode**, at no cost, without raw card data touching our server?

## Verdict
| Gateway | Verdict | One line |
|---|---|---|
| **Razorpay** (test mode) | **Conditional GO** | Test keys need no KYC, INR and paise match ADR-002, card entry is on Razorpay's side, the verification steps are small. Needs a public URL for webhooks (a tunnel) and your decision to go. |
| **Stripe** | **NO-GO for this project** | In India Stripe is invite-only and only for registered businesses (not individuals), so a student project cannot normally open an account to get keys. |

"Go" means: a follow-up implementation task may be started **only when you say so and supply the test keys yourself**. Until then the simulation stays, and ADR-009 is unchanged. See ADR-011 (Proposed).

## What was checked, and how sure we are
Vendor documentation read on 2026-10-29. Items marked **(not re-read)** come from general knowledge of the vendor and were not confirmed on a page during this spike; check them before relying on them.

### Razorpay
- **Account and KYC.** Test Mode lets you "start integration immediately without KYC completion"; KYC (24-48 hours) is needed only for Live Mode. Test keys start with `rzp_test_`, are generated in Dashboard > Account & Settings > API Keys; the secret is shown once; only Owner/Admin roles see keys. Not documented on the pages read: exactly what the first signup asks for (email/phone verification is likely; **unknown**).
- **Flow (Standard Checkout).** 1) Server creates an **Order** (`amount` in the smallest unit, `currency`); the browser gets only the `order_id`. A payment without an order cannot be captured and is auto-refunded. 2) Razorpay's checkout (modal or hosted page) collects card/UPI/netbanking; our server sees only `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` (POSTed to a callback URL or returned to the page). 3) Server verifies: HMAC-SHA256 of `order_id|payment_id` keyed with the key secret, using the order id **from our own database**, compared in constant time. 4) Capture: enable auto-capture or capture within the window; uncaptured payments are auto-refunded. The guide implies card data stays with Razorpay and tells you to keep card numbers/CVVs out of logs; it does not spell out PCI scope, so the "no card data on our server" claim should be worded exactly that way and no stronger.
- **Webhooks.** Signature in `X-Razorpay-Signature`: HMAC-SHA256 of the **raw** body with the webhook secret (do not parse before verifying; a rotated secret still applies to older retries). Events can arrive **more than once and out of order** (`payment.authorized` is usually, not always, before `payment.captured`). Deduplicate with `x-razorpay-event-id`. Webhooks are the recommended source of truth; for the "Payment successful" page, fall back to an API fetch if the webhook has not arrived. **Retry schedule: not documented on the page read.**
- **Local testing.** `localhost` cannot receive webhooks. Razorpay says many tunnel services are blacklisted, naming `ngrok.io` and `loca.lt`, and suggests `zrok`; a deployed staging host in Test mode also works. Editing a test-mode webhook asks for the OTP `754081`. Test events fire for Test-mode transactions.
- **Test scenarios.** Simulated OTPs (4 digits succeeds, 5 digits starting with 1 fails, 6-10 digits succeeds); netbanking mock page with Success/Failure buttons; wallets take any test amount.
- **Idempotency.** For webhooks: the event id. For our own calls: create the Order once per attempt and store its id; do not rely on a vendor idempotency header for Orders (**not verified**).
- **Cost.** Test mode: free. Live fees and settlement terms: **not assessed** (out of scope for a test-mode spike).

### Stripe
- **Availability in India.** The India page says Stripe "is available by invite only in India"; businesses cannot sign up through the website and must request an invite. Accounts must be a registered Indian business (sole proprietorship, LLP or company); **individuals are not allowed**. Sandboxes exist for accounts that have one, but you need the account first.
- **Other facts (read).** API v1 idempotency: `Idempotency-Key` header on POST, keys up to 255 characters, saved results can be pruned after 24 hours, parameter mismatch on a reused key is an error.
- **Webhooks (not re-read; general knowledge).** `Stripe-Signature` header, HMAC-SHA256 over `timestamp.rawBody`, a replay tolerance (5 minutes by default), the Stripe CLI (`stripe listen --forward-to localhost:...`) makes local testing possible **without a public tunnel**, events are retried for days and can be duplicated. This is Stripe's real advantage for local development, but it does not matter if an account cannot be opened.
- **Conclusion.** Unless the owner already has a Stripe account in a supported country (or an invite), Stripe is not usable here. International (non-INR) presentment from India also needs export fields (customer name, billing address, description) and a business entity, which is far outside this project.

## How it would fit the existing code (if "go")
Today: `services/payments.js` asks `provider.charge()` and gets an answer at once; a booking is `awaiting_payment` with its nights held for `PAYMENT_HOLD_MINUTES` (default 15); `PaymentAttempt` has `provider: "simulated"` and three unique indexes (one attempt per booking + key, one live charge per booking, one refund per booking).

A real gateway is **asynchronous**, so the synchronous `charge()` interface is not enough. A follow-up task would:
1. Add a provider `razorpay` next to `simulated`: `createOrder({ amountMinor, currency, receipt })`, `verifyPayment({ orderId, paymentId, signature })`, `verifyWebhook(rawBody, signature)`, `refund(paymentId, amountMinor)`. Amounts are integer paise already (ADR-002).
2. Extend `PaymentAttempt` with `providerOrderId`, `providerPaymentId`, `provider: "razorpay"`; keep one live charge per booking. Add a small `WebhookEvent` collection with a unique `eventId` to deduplicate.
3. Pay page: create the Order server-side when the page opens (stored on the attempt), load Razorpay's checkout script, and on return verify the signature and move the booking exactly as `pay()` does today (`expectStatus: "awaiting_payment"`). Never trust the browser's `amount`, `order_id` or "success".
4. Webhook route `POST /webhooks/razorpay`: must receive the **raw** body (a route-level `express.raw`, before any parser that consumes it); exempt from CSRF (it has no session; the signature is its authentication) and from login; respond 200 fast; ignore duplicates; handle out-of-order events; never throw on unknown events.
5. Security headers: `script-src` and `frame-src`/`connect-src` in `src/middleware/security.js` must allow Razorpay's checkout origin (exact origins to be read from its docs at implementation time); nothing else loosened.
6. Holds and timing: the 15-minute payment hold must be longer than the gateway's order/checkout window, or a late success can arrive after the booking expired. Rule: a payment that succeeds after expiry is **refunded** through the gateway and recorded, never silently lost (today's `booking_unavailable` voiding is the simulated version of this).
7. Refunds: call the gateway refund with the amount `cancellations.refundFor` worked out; record `refunded` only when the gateway confirms (webhook `refund.processed` or API fetch).
8. Config: `PAYMENT_PROVIDER=simulated|razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (validated at startup only when selected; never logged, never in the repository). Production must refuse `rzp_test_` keys unless explicitly allowed, and the UI keeps the "TEST MODE: no money moves" banner whenever test keys are in use.
9. Tests: signature verification with known vectors (right, wrong, tampered amount, replayed event id), double webhook, out-of-order events, late success after expiry, refund idempotency; a manual checklist for the real test-mode round trip.
Rough size: **L** (3-5 days part-time), mostly the webhook path, the async pay page and the tests.

## What the owner needs to provide for a "go"
- A Razorpay account with **test** API keys and a webhook secret.
- A public URL for webhooks while developing (`zrok` as Razorpay suggests, or a deployed test host).
- A decision on whether the demo should show a real checkout window (and accept that it needs internet and a third-party script) or keep the self-contained simulation. For a college demonstration the simulation is more reliable offline; test mode is stronger as evidence of a real integration.

## Risks and open questions
- Third-party script and frames in checkout loosen the CSP for those origins and add a dependency on their uptime during a demo.
- Test-mode behaviour can differ from live; the feature must be described as "gateway test mode", not "payments".
- Tunnel services are blocked or change; a deployed staging host is the more stable option.
- Not checked: the Razorpay Node SDK's maintenance status and Express 5 compatibility (a follow-up would use plain HMAC with `node:crypto` and `fetch`, which needs no SDK).
- Not checked: Razorpay's rules on refunds for test payments, order expiry length, rate limits, and the exact retry schedule of webhooks.

## Sources
- Razorpay: [Quickstart (test mode, keys, KYC)](https://razorpay.com/docs/payments/quickstart.md), [Validate and test webhooks](https://razorpay.com/docs/webhooks/validate-test), [Integration steps (Orders, signature, capture, webhooks)](https://razorpay.com/docs/payments/payment-gateway/web-integration/hosted/integration-steps), [Standard Checkout guide](https://razorpay.com/docs/developer-tools/integrations/standard-checkout/)
- Stripe: [Accept international payments from India (invite only, requirements)](https://docs.stripe.com/india-accept-international-payments), [Idempotent requests](https://docs.stripe.com/api/idempotent_requests.md)
