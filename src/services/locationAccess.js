// Who may see where a home really is (P06-T02).
//
// Everybody sees the approximate (public) point. The precise point and the
// street address (address.line1) are shown only to
//   * the listing's host and admins, and
//   * a guest whose reservation of THIS listing is confirmed (or completed).
// A pending, expired or cancelled reservation does not count; neither does a
// reservation of another listing. Pure: the reservation is passed in, nothing is
// read from a database. The trip page (P09-T01) calls this.
const { isAdmin, sameId } = require("../policies/shared");
const { toMapPoint } = require("../utils/geo");

const REVEALING_STATUSES = Object.freeze(["confirmed", "completed"]);

function mayViewPreciseLocation({ viewer, listing, reservation } = {}) {
  if (!viewer || !listing) return false;
  if (isAdmin(viewer) || sameId(listing.owner, viewer)) return true;
  return Boolean(
    reservation &&
      REVEALING_STATUSES.includes(reservation.status) &&
      sameId(reservation.guest, viewer) &&
      sameId(reservation.listing, listing),
  );
}

/**
 * @returns {{ point: { lng: number, lat: number }, addressLine: string } | null}
 * null unless the viewer may see it (or there is nothing usable to show).
 */
function preciseLocationFor({ viewer, listing, reservation } = {}) {
  if (!mayViewPreciseLocation({ viewer, listing, reservation })) return null;
  const read = (path) =>
    typeof listing.get === "function"
      ? listing.get(path)
      : path.split(".").reduce((n, k) => (n == null ? undefined : n[k]), listing);
  const coordinates = read("geometry.coordinates");
  const point = toMapPoint({
    type: read("geometry.type"),
    coordinates: coordinates ? Array.from(coordinates) : undefined,
  });
  if (!point) return null;
  return { point, addressLine: String(read("address.line1") ?? "") };
}

module.exports = { mayViewPreciseLocation, preciseLocationFor, REVEALING_STATUSES };
