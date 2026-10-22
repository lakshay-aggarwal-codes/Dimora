// Who may see a booking (P09-T01). `(user, reservation) => boolean`.
// Cancelling, accepting and declining get their own actions in P09-T02/T03.
const { sameId, isActiveUser, isAdmin } = require("./shared");

/** The guest who booked it, the host of the place, or an admin. */
function view(user, reservation) {
  if (!reservation || !isActiveUser(user)) return false;
  return Boolean(
    sameId(reservation.guest, user._id) ||
    sameId(reservation.host, user._id) ||
    isAdmin(user),
  );
}

module.exports = { view };
