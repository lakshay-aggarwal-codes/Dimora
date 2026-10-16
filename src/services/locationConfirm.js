// Changing a listing's address (P04-T04): the new address is looked up first and
// the host must confirm the match before it is saved. The looked-up point is
// kept on the server (in the session) and tied to the exact address that was
// looked up, so the confirm form can never supply coordinates of its own.
const crypto = require("node:crypto");

const TTL_MS = 15 * 60 * 1000;
const FIELDS = ["line1", "city", "state", "country", "postalCode"];

/** A fingerprint of (listing, address): the same address text gives the same key. */
function addressKey(listingId, address) {
  const text = [String(listingId), ...FIELDS.map((f) => String(address[f] ?? "").trim())].join("\u0000");
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Remembers a look-up result for this session. */
function rememberLookup(session, listingId, address, { geometry, placeName }, now = Date.now()) {
  session.pendingLocation = {
    key: addressKey(listingId, address),
    geometry,
    placeName,
    at: now,
  };
}

/**
 * The remembered point if it is for exactly this listing and address and is
 * not older than 15 minutes, else null. Clears it either way once it has been
 * asked for, so a confirmation works once.
 */
function takeLookup(session, listingId, address, now = Date.now()) {
  const pending = session && session.pendingLocation;
  if (!pending) return null;
  delete session.pendingLocation;
  if (pending.key !== addressKey(listingId, address)) return null;
  if (typeof pending.at !== "number" || now - pending.at > TTL_MS) return null;
  return pending;
}

module.exports = { addressKey, rememberLookup, takeLookup, TTL_MS };
