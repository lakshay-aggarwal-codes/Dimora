// Who may use a conversation (P11-T02). Only its two people: neither an admin
// nor anyone else. (An admin reaches a message only through a report, P12-T04.)
const { sameId, isActiveUser } = require("./shared");

/** True when `user` is the guest or the host of `conversation` (active or not). */
function isParticipant(user, conversation) {
  return Boolean(
    user &&
    conversation &&
    (sameId(conversation.guest, user._id) ||
      sameId(conversation.host, user._id)),
  );
}

/**
 * Start a conversation about a listing ("Contact host"): any active member
 * except the listing's own host. Whether the host can receive messages is
 * checked by the service.
 */
function start(user, listing) {
  if (!isActiveUser(user) || !listing) return false;
  return !sameId(listing.owner, user._id);
}

/** Read a conversation: its guest or host, while their account is active. */
function view(user, conversation) {
  return isActiveUser(user) && isParticipant(user, conversation);
}

/** Send a message: same people as `view`. */
function send(user, conversation) {
  return view(user, conversation);
}

module.exports = { start, view, send, isParticipant };
