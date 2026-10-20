// Reservation state machine (P07-T05). The only place that says which status
// changes are allowed, and who may make them. Pure: no database, no clock.
//
//   pending ──host──► confirmed        confirmed ──guest──► cancelled_by_guest
//   pending ──host──► declined         confirmed ──host───► cancelled_by_host
//   pending ──system► expired          confirmed ──system─► completed
//   pending ──guest─► cancelled_by_guest
//
// A booking on an instant-book listing is created already `confirmed`
// (that is a creation, not a transition). Any other move is an
// InvalidTransitionError (409).
//
// Nights: pending and confirmed reservations hold their nights in the ledger
// (ADR-004). declined, expired and both cancellations RELEASE them. completed
// keeps its (past) rows, as ADR-004 says "past rows kept".
const { InvalidTransitionError } = require("../utils/errors");

const STATUSES = Object.freeze([
  "pending",
  "confirmed",
  "declined",
  "expired",
  "cancelled_by_guest",
  "cancelled_by_host",
  "completed",
]);

const ACTORS = Object.freeze(["guest", "host", "system"]);

// from -> to -> the actors who may make the move.
const TRANSITIONS = Object.freeze({
  pending: Object.freeze({
    confirmed: ["host"],
    declined: ["host"],
    expired: ["system"],
    cancelled_by_guest: ["guest"],
  }),
  confirmed: Object.freeze({
    cancelled_by_guest: ["guest"],
    cancelled_by_host: ["host"],
    completed: ["system"],
  }),
  declined: Object.freeze({}),
  expired: Object.freeze({}),
  cancelled_by_guest: Object.freeze({}),
  cancelled_by_host: Object.freeze({}),
  completed: Object.freeze({}),
});

const RELEASING = Object.freeze([
  "declined",
  "expired",
  "cancelled_by_guest",
  "cancelled_by_host",
]);

const isStatus = (value) => STATUSES.includes(value);

/** Statuses a reservation can still leave. */
const isTerminal = (status) =>
  isStatus(status) && Object.keys(TRANSITIONS[status]).length === 0;

/** Does a reservation in this status keep rows in the night ledger? */
const holdsNights = (status) =>
  status === "pending" || status === "confirmed" || status === "completed";

/** Does moving INTO this status free the nights? */
const releasesNights = (to) => RELEASING.includes(to);

/** Is `from -> to` in the table (any actor)? */
function canTransition(from, to) {
  return isStatus(from) && isStatus(to) && Boolean(TRANSITIONS[from][to]);
}

/** Actors allowed to make `from -> to` (empty when the move is not allowed). */
function actorsFor(from, to) {
  return canTransition(from, to) ? [...TRANSITIONS[from][to]] : [];
}

/**
 * Throws InvalidTransitionError (409) unless the move is in the table and, when
 * `actor` is given, that actor may make it.
 */
function assertTransition(from, to, actor) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (actor !== undefined && !TRANSITIONS[from][to].includes(actor)) {
    throw new InvalidTransitionError(
      from,
      to,
      `A ${actor} cannot change a reservation from ${from} to ${to}.`,
    );
  }
}

module.exports = {
  STATUSES,
  ACTORS,
  TRANSITIONS,
  isStatus,
  isTerminal,
  holdsNights,
  releasesNights,
  canTransition,
  actorsFor,
  assertTransition,
};
