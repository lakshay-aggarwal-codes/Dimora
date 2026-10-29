# ADR-011: A payment gateway only in test mode, Razorpay if anything; Stripe is out

- Status: **Proposed** (needs the owner's go; nothing is implemented)
- Date: 2026-10-29
- Source: P16-T02; findings in `docs/GATEWAY_SPIKE.md`

## Context

ADR-009 keeps payments simulated. P16-T02 asked whether a real gateway's **test mode** is feasible without cost and without card data touching our server. The market is India (ADR-008) and the project is a college project run by one person.

## Decision (proposed)

1. **Razorpay test mode is feasible and is the only candidate.** Test keys need no KYC; INR and integer paise fit ADR-002; card entry happens on Razorpay's checkout; verification is a small HMAC check of the payment and of each webhook.
2. **Stripe is not a candidate.** It is invite-only in India and only for registered businesses, not individuals, so keys are not obtainable in the normal way.
3. **Implementation starts only when the owner says "go" and supplies the test keys.** It would be a separate task (sized L): provider interface made asynchronous, webhook endpoint (raw body, no CSRF, signature-checked, de-duplicated by event id), pay page with Razorpay checkout, CSP additions limited to its origins, late-success-after-expiry refunded, startup validation of the keys.
4. **Until then ADR-009 stands.** The simulation remains the default and the fallback even after a gateway exists (`PAYMENT_PROVIDER`).
5. Whatever is built keeps the rules of ADR-009: no raw card data on our pages or in our logs, and every payment step labelled as test mode.

## Consequences

- No code, dependency or configuration changes now.
- The demo stays self-contained and works offline.
- If "go": a public URL (tunnel or staging host) is needed for webhooks, and the CSP is loosened for the gateway's origins only.

## Alternatives rejected

- **Stripe test mode.** Cannot get an account (invite-only, business entities only).
- **Implement now.** No keys, no public URL, and the owner has not chosen; a half-built webhook endpoint would be a security liability.
- **A fake card form for realism.** Rejected in ADR-009 and still rejected.
