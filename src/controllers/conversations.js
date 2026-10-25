// Messages (P11-T02): JSON endpoints under /api and three small pages (the
// "Contact host" button, the inbox list, one thread, the reply form). Everything works on the signed-in member's own
// conversations; the service answers 404 for anyone else's.
const conversations = require("../services/conversations");
const { AppError, ValidationError } = require("../utils/errors");

const str = (value) => (typeof value === "string" ? value : undefined);

function needLogin(req) {
  if (!req.user) {
    throw new AppError(401, "Please log in.", { code: "unauthenticated" });
  }
}
const noStore = (res) => res.set("Cache-Control", "no-store");

// ---- JSON (/api) ----------------------------------------------------------

module.exports.apiList = async (req, res) => {
  needLogin(req);
  noStore(res);
  res.json(await conversations.listFor({}, req.user, { page: str(req.query.page) }));
};

module.exports.apiThread = async (req, res) => {
  needLogin(req);
  noStore(res);
  res.json(
    await conversations.thread({}, req.user, req.params.id, {
      before: str(req.query.before),
    }),
  );
};

module.exports.apiSend = async (req, res) => {
  needLogin(req);
  noStore(res);
  const message = await conversations.send(
    {},
    req.user,
    req.params.id,
    req.body && req.body.body,
  );
  res.status(201).json({ message });
};

function started({ conversation, created }, res) {
  const id = String(conversation._id);
  res
    .status(created ? 201 : 200)
    .json({ conversation: { id, url: `/conversations/${id}` } });
}

module.exports.apiStartForListing = async (req, res) => {
  needLogin(req);
  noStore(res);
  started(await conversations.startForListing({}, req.user, req.params.id), res);
};

module.exports.apiStartForReservation = async (req, res) => {
  needLogin(req);
  noStore(res);
  started(
    await conversations.startForReservation({}, req.user, req.params.id),
    res,
  );
};

// ---- Pages ----------------------------------------------------------------

/** POST /listings/:id/contact -> the conversation page. */
module.exports.contact = async (req, res) => {
  const { conversation } = await conversations.startForListing(
    {},
    req.user,
    req.params.id,
  );
  res.redirect(`/conversations/${conversation._id}`);
};

/** GET /messages?page= : the member's conversations (P11-T03). */
module.exports.inbox = async (req, res) => {
  const list = await conversations.listFor({}, req.user, {
    page: str(req.query.page),
  });
  noStore(res);
  res.render("conversations/index.ejs", {
    ...list,
    pageTitle: "Messages",
    pageDescription: "Your conversations with hosts and guests.",
  });
};

/** GET /conversations/:id */
module.exports.show = async (req, res) => {
  const before = str(req.query.before);
  const data = await conversations.thread({}, req.user, req.params.id, {
    before,
  });
  noStore(res); // private messages
  res.render("conversations/show.ejs", {
    ...data,
    // Only the newest page is kept current by polling; an older page is not.
    live: !before,
    pageTitle: `Messages: ${data.conversation.listingTitle}`,
    pageDescription: "Your messages.",
  });
};

/** POST /conversations/:id/messages (the reply form) */
module.exports.sendForm = async (req, res) => {
  const back = `/conversations/${encodeURIComponent(req.params.id)}`;
  try {
    await conversations.send({}, req.user, req.params.id, req.body && req.body.body);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    req.flash("error", err.message);
  }
  res.redirect(back);
};
