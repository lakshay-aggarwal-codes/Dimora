// Guard and audit wrapper for the /admin area (P14-T01).
const audit = require("../services/audit");
const { isAdmin } = require("../policies/shared");
const { NotFoundError } = require("../utils/errors");

/**
 * router.use(adminGuard) for the whole area. Anyone who is not an active admin
 * (visitors included) gets the ordinary 404 page, so /admin does not reveal
 * that it exists.
 */
function adminGuard(req, res, next) {
  if (!isAdmin(req.user)) throw new NotFoundError();
  res.set("Cache-Control", "no-store");
  res.locals.pageTitle = res.locals.pageTitle || "Admin";
  next();
}

/**
 * Wraps every admin route that changes data. The handler does the change and
 * RETURNS what to log; it must not respond itself:
 *
 *   router.post("/users/:id/suspend", auditedMutation(async (req) => {
 *     ...change something...
 *     return {
 *       audit: { action: "user.suspend", targetType: "user", targetId: id, reason, details },
 *       redirectTo: "/admin/users",   // or respond: (res) => res.render(...)
 *       flash: "Account suspended.",  // optional success message
 *     };
 *   }));
 *
 * The wrapper writes the audit row first and only then answers, so a change
 * without an audit entry never succeeds quietly: it throws (a 500 and a test
 * failure). The change itself has already happened by then; the answer is what
 * is withheld.
 */
function auditedMutation(handler) {
  async function run(req, res) {
    const result = await handler(req, res);
    if (res.headersSent) {
      throw new Error("auditedMutation: the handler responded itself; return { audit, ... } instead");
    }
    if (!result || !result.audit) {
      throw new Error("auditedMutation: the handler returned no audit entry");
    }
    await audit.record({ ...result.audit, req });
    if (req.auditRecorded !== 1) {
      throw new Error(`auditedMutation: expected exactly one audit entry, got ${req.auditRecorded}`);
    }
    if (result.flash) req.flash("success", result.flash);
    if (typeof result.respond === "function") return result.respond(res);
    return res.redirect(result.redirectTo || "/admin");
  }

  function auditedMutationMiddleware(req, res, next) {
    req.auditRecorded = 0;
    run(req, res).catch(next);
  }
  // Lets tests check a route table without calling anything.
  auditedMutationMiddleware.auditedMutation = true;
  return auditedMutationMiddleware;
}

module.exports = { adminGuard, auditedMutation };
