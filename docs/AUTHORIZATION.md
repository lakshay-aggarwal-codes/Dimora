# Authorization (P02-T06)

Who may do what is decided in one place: `src/policies/`.

```js
const { can } = require("../policies");
can("listing:edit", req.user, listing); // true | false
```

Policies are pure functions `(user, resource) => boolean` (no database, no request). Views use the same function: `can("listing:delete", listing)` is available in every template.

## Routes

| Tool | Use |
|---|---|
| `isLoggedIn` | anonymous -> login page (remembers the URL) |
| `authorize("listing:edit")` | loads the resource, then asks the policy. Anonymous -> login; missing -> 404; not allowed -> 403 (`{ concealForbidden: true }` gives 404 instead, for private resources); allowed -> resource on `req.listing` / `req.review` |
| `requireRole("admin")` | guard for a whole area: `router.use(requireRole("admin"))`. Anonymous -> login; other role or suspended -> 403 |

`authorize("x:y")` with an unknown action throws when the route is defined, not on the first request.

## Current rules

| Action | Allowed |
|---|---|
| `listing:create` | any active member |
| `review:create` | any active member may reach the route; whether they may review *this stay* is decided by `services/reviews.js` (completed stay, author is the guest, not the host, inside the window, one per stay; ADR-010) |
| `reservation:view` | the booking's guest, its host, or an admin (an active account) |
| `reservation:respond` | only the booking's host: accept or decline a request; admins cannot answer for a host |
| `conversation:start` | any active member except the listing's own host ("Contact host"); the service also needs a public listing and an active host |
| `conversation:view` / `conversation:send` | only the conversation's guest and host, while their accounts are active. Admins have no access to messages (they reach one only through a report, P12-T04); anyone else gets the ordinary 404 |
| `listing:edit` | the listing's owner |
| `listing:delete` | the owner, or an admin |
| `review:delete` | the review's author, or an admin (the review must belong to the listing in the URL) |
| `admin:access` | an active admin (P14-T01). The `/admin` area uses `adminGuard` (`src/middleware/admin.js`): everyone else, visitors included, gets the ordinary 404 so the area does not reveal itself |

"Active" = `status` is `active` (accounts without a `status` count as active). Suspended and deleted accounts can do nothing. A listing without an owner (old data) can be removed only by an admin; a review without an author likewise.

## The route matrix (P17-T01)

`tests/helpers/routeMatrix.js` lists every route of the app: its method and path, how it is guarded (`public`, `login`, `authorize` + action, `inline-login`, `admin`) and who may use it. `tests/unit/routeMatrix.test.js` builds the real app, reads its router stack and fails when

- a route has no entry (a new route is not finished until someone decides who may use it) or an entry has no route any more;
- the guards on a route are not the ones its entry names (`isLoggedIn`, `authorize(<action>)` with exactly that action, `adminGuard` in front of everything under `/admin`, every admin write wrapped in `auditedMutation`);
- a public route other than sign-up, log-in and log-out changes data;
- an anonymous request is not turned away as the entry says: 302 to `/login` (`login`, `authorize`), 401 JSON (`inline-login`), 404 (`admin`).

`authorize(action)` marks the middleware it returns with `policyAction` so the test can see which action guards a route. The matrix says *who gets in the door*; object-level rules (is this booking yours?) stay in the policies and the services and are tested in `tests/integration/authz.db.test.js` and the per-feature suites.

## Adding a rule

1. Write the function in `src/policies/<resource>.js` and register it in `src/policies/index.js`.
2. Add a loader in `src/middleware/authorize.js` if the action needs a resource (and a message).
3. Add the route's line to `tests/helpers/routeMatrix.js` (the route matrix test fails without it).
4. Add rows to `tests/unit/policies.test.js` (it fails if an action is registered but missing from the matrix) and to `tests/integration/authz.db.test.js`.

## Admin area (P14-T01)

- Admin rights come only from `npm run make-admin -- <email>`; no page, form or API sets `role`.
- Every admin route that changes data is wrapped in `auditedMutation`; the handler returns `{ audit, redirectTo | respond, flash }` and the wrapper writes exactly one `AuditLog` row, then answers. `tests/unit/admin.routes.test.js` fails if a non-GET admin route is not wrapped.
- The audit log is append-only in the model and read-only in the UI; there is no route that edits or deletes a row.
- User management (P14-T02): an admin cannot suspend their own account or the last active admin; a suspension needs a written reason, which is stored in the audit log. Suspended accounts are denied everything by the policies and cannot log in; their sessions are deleted at the moment of suspension.
