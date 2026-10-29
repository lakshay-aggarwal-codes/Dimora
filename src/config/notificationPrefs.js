// Which notifications may also be emailed, and which the member can turn off
// (P11-T05). In-app notifications are always on: only the EMAIL copy has a
// switch. Every notification type of notificationEvents.js belongs to exactly
// one group.
//
//   essential: true  -> the email is sent whatever the member chose (it is about
//                       something they run, e.g. their listing being suspended),
//                       carries no unsubscribe link, and the switch is shown as
//                       locked.
//   default          -> used until the member has chosen.
const GROUPS = Object.freeze([
  Object.freeze({
    key: "bookings",
    label: "Bookings",
    description: "Requests, answers, cancellations and changed dates for your stays and your listings.",
    essential: false,
    default: true,
    types: Object.freeze([
      "reservation.requested",
      "reservation.booked",
      "reservation.modified",
      "reservation.accepted",
      "reservation.declined",
      "reservation.expired",
      "reservation.cancelled",
    ]),
  }),
  Object.freeze({
    key: "reminders",
    label: "Reminders",
    description: "A reminder the day before a stay starts.",
    essential: false,
    default: true,
    types: Object.freeze(["reservation.checkin_tomorrow"]),
  }),
  Object.freeze({
    key: "reviews",
    label: "Reviews",
    description: "When you can review a stay you finished.",
    essential: false,
    default: true,
    types: Object.freeze(["review.available"]),
  }),
  Object.freeze({
    key: "moderation",
    label: "Decisions about your listings",
    description: "When a listing of yours is suspended or restored by the site's administrators. These emails cannot be turned off.",
    essential: true,
    default: true,
    types: Object.freeze(["listing.suspended", "listing.restored"]),
  }),
]);

const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));
const GROUP_OF_TYPE = new Map(GROUPS.flatMap((g) => g.types.map((t) => [t, g])));
const TOGGLEABLE = Object.freeze(GROUPS.filter((g) => !g.essential).map((g) => g.key));

module.exports = { GROUPS, GROUP_BY_KEY, GROUP_OF_TYPE, TOGGLEABLE };
