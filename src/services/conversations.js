// Conversations and messages (P11-T02).
//
//   startForListing(deps, user, listingId)         -> { conversation, created }
//   startForReservation(deps, user, reservationId) -> { conversation, created }
//   send(deps, user, conversationId, body)         -> the stored message
//   thread(deps, user, conversationId, { before }) -> { conversation, messages, hasMore, nextBefore }
//   listFor(deps, user, { page })                  -> { conversations, page, totalPages, total }
//
// Rules, all enforced here and never by a form or a script:
// - Only the conversation's guest and host can read or write it. Anyone else
//   (an admin included), a missing id and a malformed id are the same 404.
// - "Contact host" works on a public listing and never on your own listing.
//   There is one general conversation per (listing, guest) and one per booking
//   (the unique `threadKey` decides, so two clicks make one conversation).
// - Nothing is sent, and no conversation is started, while either account is
//   not active (suspended or deleted).
// - A message is plain text, 1-1000 characters; a longer one is refused, never
//   cut. Views print it escaped.
// - Each side has its own unread counter: sending raises the other side's,
//   opening the thread resets your own.
// - A conversation with no message yet is not listed.
// `deps` lets tests pass fakes; `now` is the clock.
const { can } = require("../policies");
const { isParticipant } = require("../policies/conversation");
const { sameId, isActiveUser } = require("../policies/shared");
const { isPublic } = require("../utils/visibility");
const { LIMITS, PAGE_SIZE, LIST_SIZE } = require("../config/conversations");
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../utils/errors");
const { DEFAULT_TIMEZONE } = require("../utils/dates");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// Tab and new line are allowed; every other control character is not.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const models = (deps = {}) => ({
  Conversation: deps.ConversationModel || require("../models/conversation"),
  Message: deps.MessageModel || require("../models/message"),
  Listing: deps.ListingModel || require("../models/listing"),
  Reservation: deps.ReservationModel || require("../models/reservation"),
  User: deps.UserModel || require("../models/user"),
});
const clock = (deps) => (deps && deps.now) || new Date();
const idText = (value) => String(value && value._id ? value._id : value);
const validId = (value) => typeof value === "string" && OBJECT_ID.test(value);

/** "guest" or "host": which side `user` is on. Call only for a participant. */
const sideOf = (user, conversation) =>
  sameId(conversation.guest, user._id) ? "guest" : "host";
const otherSide = (side) => (side === "guest" ? "host" : "guest");

const when = (date) =>
  date instanceof Date
    ? new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: DEFAULT_TIMEZONE,
      }).format(date)
    : "";

/** The trimmed plain text of a message, or a ValidationError. */
function parseBody(raw) {
  if (typeof raw !== "string") {
    throw new ValidationError("Write a message first.");
  }
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new ValidationError("Write a message first.");
  if (CONTROL.test(body)) {
    throw new ValidationError("That message has characters we cannot send.");
  }
  if (body.length > LIMITS.body) {
    throw new ValidationError(
      `Messages can be up to ${LIMITS.body} characters (yours has ${body.length}).`,
    );
  }
  return body;
}

const preview = (body) => body.replace(/\s+/g, " ").slice(0, LIMITS.preview);

/** Accounts of both people must be active, or nothing is started or sent. */
async function assertBothActive(M, guestId, hostId) {
  const users = await M.User.find({ _id: { $in: [guestId, hostId] } })
    .select("status")
    .lean();
  const ok =
    users.length === (sameId(guestId, hostId) ? 1 : 2) &&
    users.every((u) => isActiveUser(u));
  if (!ok) {
    throw new ConflictError(
      "Messages are not available in this conversation right now.",
    );
  }
}

/** The existing conversation for `threadKey`, or a new one (idempotent). */
async function findOrCreate(M, threadKey, fields) {
  const existing = await M.Conversation.findOne({ threadKey }).lean();
  if (existing) return { conversation: existing, created: false };
  try {
    const row = await M.Conversation.create({ threadKey, ...fields });
    const conversation =
      row && typeof row.toObject === "function" ? row.toObject() : row;
    return { conversation, created: true };
  } catch (err) {
    // Lost a race with a second click: the unique index says the thread exists.
    if (err && err.code === 11000) {
      const winner = await M.Conversation.findOne({ threadKey }).lean();
      if (winner) return { conversation: winner, created: false };
    }
    throw err;
  }
}

/** "Contact host": the guest's general conversation about a public listing. */
async function startForListing(deps, user, listingId) {
  const M = models(deps);
  const listing = validId(listingId)
    ? await M.Listing.findById(listingId).select("owner status deletedAt").lean()
    : null;
  if (!listing || !isPublic(listing)) {
    throw new NotFoundError("That listing does not exist.");
  }
  if (!user || !isActiveUser(user)) {
    throw new ForbiddenError("Your account cannot send messages.");
  }
  if (sameId(listing.owner, user._id)) {
    throw new ForbiddenError("You cannot message yourself about your own listing.");
  }
  if (!can("conversation:start", user, listing)) {
    throw new ForbiddenError("You cannot message this host.");
  }
  await assertBothActive(M, user._id, listing.owner);
  return findOrCreate(M, `listing:${idText(listing._id)}:${idText(user._id)}`, {
    listing: listing._id,
    guest: user._id,
    host: listing.owner,
    reservation: null,
  });
}

/** The conversation about one booking; either of its two people may open it. */
async function startForReservation(deps, user, reservationId) {
  const M = models(deps);
  const reservation = validId(reservationId)
    ? await M.Reservation.findById(reservationId)
        .select("listing guest host")
        .lean()
    : null;
  // Not the guest or host (an admin included) = the same 404 as a missing booking.
  if (!reservation || !isParticipant(user, reservation)) {
    throw new NotFoundError("That booking does not exist.");
  }
  if (!isActiveUser(user)) {
    throw new ForbiddenError("Your account cannot send messages.");
  }
  await assertBothActive(M, reservation.guest, reservation.host);
  return findOrCreate(M, `reservation:${idText(reservation._id)}`, {
    listing: reservation.listing,
    guest: reservation.guest,
    host: reservation.host,
    reservation: reservation._id,
  });
}

/** The conversation if `user` is one of its two people, else a 404. */
async function loadFor(M, user, id) {
  const conversation =
    validId(id) && user ? await M.Conversation.findById(id).lean() : null;
  if (!conversation || !isParticipant(user, conversation)) {
    throw new NotFoundError("That conversation does not exist.");
  }
  if (!can("conversation:view", user, conversation)) {
    throw new ForbiddenError("Your account cannot use messages.");
  }
  return conversation;
}

function describeMessage(row, user) {
  const created = row.createdAt instanceof Date ? row.createdAt : null;
  return {
    id: idText(row._id),
    body: row.body,
    mine: sameId(row.sender, user._id),
    when: when(created),
    iso: created ? created.toISOString() : "",
  };
}

/** Sends one message and raises the other side's unread counter. */
async function send(deps, user, conversationId, rawBody) {
  const M = models(deps);
  const conversation = await loadFor(M, user, conversationId);
  if (!can("conversation:send", user, conversation)) {
    throw new ForbiddenError("Your account cannot send messages.");
  }
  await assertBothActive(M, conversation.guest, conversation.host);
  const body = parseBody(rawBody);
  const now = clock(deps);
  const row = await M.Message.create({
    conversation: conversation._id,
    sender: user._id,
    body,
  });
  const side = sideOf(user, conversation);
  await M.Conversation.updateOne(
    { _id: conversation._id },
    {
      $inc: { [`unread.${otherSide(side)}`]: 1 },
      $set: {
        lastMessageAt: now,
        "lastMessage.sender": user._id,
        "lastMessage.preview": preview(body),
      },
    },
  );
  return describeMessage(
    {
      ...(typeof row.toObject === "function" ? row.toObject() : row),
      createdAt: (row && row.createdAt) || now,
    },
    user,
  );
}

async function people(M, conversation) {
  const [users, listings] = await Promise.all([
    M.User.find({ _id: { $in: [conversation.guest, conversation.host] } })
      .select("displayName username status")
      .lean(),
    M.Listing.find({ _id: { $in: [conversation.listing] } })
      .select("title")
      .lean(),
  ]);
  return { users, listings };
}

const nameOf = (users, id) => {
  const u = users.find((x) => sameId(x, id));
  return u ? u.displayName || u.username || "A member" : "A member";
};

/**
 * Messages of one conversation, oldest first, PAGE_SIZE at a time: the newest
 * page, or the page before the message id `before`. Opening it marks the
 * viewer's side read.
 */
async function thread(deps, user, conversationId, { before } = {}) {
  const M = models(deps);
  const conversation = await loadFor(M, user, conversationId);
  const filter = { conversation: conversation._id };
  if (validId(before)) filter._id = { $lt: before };
  const rows = await M.Message.find(filter)
    .sort({ _id: -1 })
    .limit(PAGE_SIZE + 1)
    .lean();
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();

  const side = sideOf(user, conversation);
  if (conversation.unread && conversation.unread[side] > 0) {
    await M.Conversation.updateOne(
      { _id: conversation._id, [`unread.${side}`]: { $gt: 0 } },
      { $set: { [`unread.${side}`]: 0 } },
    );
  }
  const { users, listings } = await people(M, conversation);
  const otherId = side === "guest" ? conversation.host : conversation.guest;
  const other = users.find((u) => sameId(u, otherId));
  const mine = users.find((u) => sameId(u, user._id));
  const listing = listings[0];
  return {
    conversation: {
      id: idText(conversation._id),
      side,
      listingId: idText(conversation.listing),
      listingTitle: listing ? listing.title : "A listing",
      reservationId: conversation.reservation
        ? idText(conversation.reservation)
        : null,
      otherName: nameOf(users, otherId),
      // Neither side can write while either account is not active.
      canReply: Boolean(
        other && mine && isActiveUser(other) && isActiveUser(mine),
      ),
    },
    messages: page.map((row) => describeMessage(row, user)),
    hasMore,
    nextBefore: hasMore && page.length > 0 ? idText(rows[PAGE_SIZE - 1]._id) : null,
  };
}

/** The member's conversations that have messages, newest message first. */
async function listFor(deps, user, { page } = {}) {
  const M = models(deps);
  const mine = { $or: [{ guest: user._id }, { host: user._id }] };
  const filter = { $and: [mine, { lastMessageAt: { $ne: null } }] };
  const total = await M.Conversation.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / LIST_SIZE));
  const n = typeof page === "string" && /^\d{1,6}$/.test(page) ? Number(page) : 1;
  const current = Math.min(Math.max(1, n), totalPages);
  const rows = await M.Conversation.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .skip((current - 1) * LIST_SIZE)
    .limit(LIST_SIZE)
    .lean();

  const userIds = [];
  const listingIds = [];
  for (const row of rows) {
    userIds.push(row.guest, row.host);
    listingIds.push(row.listing);
  }
  const [users, listings] = await Promise.all([
    rows.length
      ? M.User.find({ _id: { $in: userIds } })
          .select("displayName username")
          .lean()
      : [],
    rows.length
      ? M.Listing.find({ _id: { $in: listingIds } })
          .select("title")
          .lean()
      : [],
  ]);
  return {
    conversations: rows.map((row) => {
      const side = sideOf(user, row);
      const listing = listings.find((l) => sameId(l, row.listing));
      return {
        id: idText(row._id),
        side,
        listingTitle: listing ? listing.title : "A listing",
        otherName: nameOf(users, side === "guest" ? row.host : row.guest),
        preview: (row.lastMessage && row.lastMessage.preview) || "",
        lastFromMe: Boolean(
          row.lastMessage && sameId(row.lastMessage.sender, user._id),
        ),
        when: when(row.lastMessageAt),
        unread: (row.unread && row.unread[side]) || 0,
      };
    }),
    page: current,
    totalPages,
    total,
  };
}

module.exports = {
  startForListing,
  startForReservation,
  send,
  thread,
  listFor,
  parseBody,
};
