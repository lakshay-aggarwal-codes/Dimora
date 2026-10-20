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
| `listing:create`, `review:create` | any active member |
| `listing:edit` | the listing's owner |
| `listing:delete` | the owner, or an admin |
| `review:delete` | the review's author, or an admin (the review must belong to the listing in the URL) |
| `admin:access` | an active admin (P14-T01). The `/admin` area uses `adminGuard` (`src/middleware/admin.js`): everyone else, visitors included, gets the ordinary 404 so the area does not reveal itself |

"Active" = `status` is `active` (accounts without a `status` count as active). Suspended and deleted accounts can do nothing. A listing without an owner (old data) can be removed only by an admin; a review without an author likewise.

## Adding a rule

1. Write the function in `src/policies/<resource>.js` and register it in `src/policies/index.js`.
2. Add a loader in `src/middleware/authorize.js` if the action needs a resource (and a message).
3. Add rows to `tests/unit/policies.test.js` (it fails if an action is registered but missing from the matrix) and to `tests/integration/authz.db.test.js`.

## Admin area (P14-T01)

- Admin rights come only from `npm run make-admin -- <email>`; no page, form or API sets `role`.
- Every admin route that changes data is wrapped in `auditedMutation`; the handler returns `{ audit, redirectTo | respond, flash }` and the wrapper writes exactly one `AuditLog` row, then answers. `tests/unit/admin.routes.test.js` fails if a non-GET admin route is not wrapped.
- The audit log is append-only in the model and read-only in the UI; there is no route that edits or deletes a row.
- User management (P14-T02): an admin cannot suspend their own account or the last active admin; a suspension needs a written reason, which is stored in the audit log. Suspended accounts are denied everything by the policies and cannot log in; their sessions are deleted at the moment of suspension.
