// Who may do what with a booking. `(user, reservation) => boolean`.
// Cancelling (P09-T03) gets its own actions there.
const { sameId, isActiveUser, isAdmin } = require("./shared");

/** The guest who booked it, the host of the place, or an admin (P09-T01). */
function view(user, reservation) {
  if (!reservation || !isActiveUser(user)) return false;
  return Boolean(
    sameId(reservation.guest, user._id) ||
    sameId(reservation.host, user._id) ||
    isAdmin(user),
  );
}

/**
 * Accept or decline a request (P09-T02): only the host of that booking. An
 * admin cannot answer for a host, and a suspended host cannot answer at all.
 */
function respond(user, reservation) {
  if (!reservation || !isActiveUser(user)) return false;
  return sameId(reservation.host, user._id);
}

module.exports = { view, respond };
