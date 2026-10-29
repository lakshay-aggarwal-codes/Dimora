# ADR-009: Payments are simulated and labelled

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

A rental app needs a checkout, but this is a college project: no merchant account, and handling real card data would bring legal and security obligations.

## Decision

Payments are **simulated**. Checkout records an intent and an outcome through a payment-service interface, and the UI labels every payment step as a simulation. No raw card data (number, CVV, expiry) is collected, stored, logged or sent anywhere. Refund calculations follow the cancellation policy and are also simulated. A later spike (P16-T02) may evaluate a gateway's test mode; any real gateway would be hosted fields or redirect only, never raw card inputs on our pages.

## Consequences

- Demos work without external accounts.
- The README and UI must state clearly that no real money moves.
- The service interface lets a real or test-mode gateway be added later without rewriting booking logic.
- Payment-related security claims are limited to "no card data handled".

## Alternative rejected

Integrating a live gateway now, or a fake form that collects card fields. Rejected: a live gateway needs credentials, compliance and verified free-tier terms; collecting card-shaped data even as a mock trains the wrong pattern and is a security liability.

## Implementation note (P16-T01)

The interface is `services/payments.js` (`pay`, `refundRelease`) over `services/paymentProviders/simulated.js` (`charge`, `refund`). A booking starts as `awaiting_payment` and only a successful simulated payment moves it on; a refused one leaves it waiting with its nights held until the sweeper expires it. Attempts are stored in `PaymentAttempt` (one per booking and key, one live charge per booking, one refund per booking). The pay page asks for no card data at all.
