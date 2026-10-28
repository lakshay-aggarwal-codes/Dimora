# Trust indicators (P12-T05)

Rule: **show a fact only if the system knows it, and say only what it means.** Dimora checks nobody's identity, so nothing on the site says or hints that it does.

## What is shown (profile page and the host card of a listing)

| Indicator | Source | Shown when | Text |
|---|---|---|---|
| Email confirmed | `User.emailVerifiedAt` (P02-T05: the member opened a link sent to the address) | it is set | "Email address confirmed", with the note "'Confirmed' means this member opened a link we sent to their email address. Dimora does not check anyone's identity." |
| Member since | `User.createdAt` | always | "Member since March 2026" |
| Stays hosted | reservations with `host` = member and status `completed` | at least 1 | "2 stays hosted" |
| Response rate | requests (not instant bookings) created in the last 12 months whose history has a step from `pending`: answered = the host accepted or declined, unanswered = expired | at least 5 decided requests | "Answered 80% of booking requests in the last 12 months (5 requests)" |

Not shown, on purpose: anything for an unconfirmed member (no "not verified"), a percentage from fewer than 5 decided requests, requests the guest withdrew or that are still waiting, the email address itself.

## What does not exist, and why

"Verified host", "Superhost", "Trusted", "Top rated", ID/background-check marks: there is no independent check behind any of them. `tests/unit/trust.test.js` scans every view and email text for those phrases and fails if one appears.

## Adding an indicator

1. It must come from a stored fact, computed by `src/services/trust.js` (pure parts tested without a database).
2. Write the sentence so that it is exactly as strong as the fact.
3. Decide when it is hidden (too little data is a reason to show nothing, not a smaller number).
4. Add it to the table above and to the tests.

## Limits

- The response rate scans at most the 500 newest requests of the host; a host with more would be measured on those. The query uses the existing `host` index prefix; at demo size it is immediate (P18-T02 did not add an index for it).
- The history of requests made before status history existed (if any) has no "from pending" step and is not counted.
- Rates are computed on every page view, not cached.
- A host who deletes the account is anonymised; the profile is gone (P02-T04).
