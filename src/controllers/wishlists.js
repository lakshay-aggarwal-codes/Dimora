// /wishlists and the heart's POST /listings/:id/save (P10-T01).
const service = require("../services/wishlists");
const lists = require("../services/wishlistLists");
const searches = require("../services/savedSearches");
const shared = require("../services/sharedLists");
const { ValidationError, ConflictError } = require("../utils/errors");
const { safeRedirectPath } = require("../utils/safeRedirect");

/** Where a form (no JavaScript) goes back to: the page it was sent from. */
function backPath(req, fallback) {
  try {
    const from = new URL(req.get("referer") || "");
    if (from.host === req.get("host")) {
      return safeRedirectPath(from.pathname + from.search, fallback);
    }
  } catch {
    // no or unreadable Referer: use the fallback
  }
  return fallback;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const plain = (value) => (typeof value === "string" ? value : undefined);

// `?list=<id>` shows one list (with notes and "move"); without it every saved
// stay is shown once. An id that is not the member's own shows everything.
module.exports.index = async (req, res) => {
  const all = await service.listsFor(req.user._id);
  const wanted = plain(req.query.list);
  const current = OBJECT_ID.test(wanted || "") ? all.find((l) => l.id === wanted) || null : null;
  const saved = await service.overview(req.user._id, undefined, current ? { listId: current.id } : {});
  res.set("Cache-Control", "no-store");
  res.render("wishlists/index.ejs", {
    ...saved,
    lists: all,
    currentList: current,
    pageTitle: current ? current.name : "Saved stays",
    pageDescription: "The stays you saved on Dimora.",
  });
};

// Body: saved=true | saved=false. The page sends the state it wants, so
// repeating a request never flips the heart back.
module.exports.save = async (req, res) => {
  const value = req.body && req.body.saved;
  if (value !== "true" && value !== "false") {
    throw new ValidationError("Say whether to save or to remove this stay.");
  }
  const result = await service.setSaved(
    req.user._id,
    req.params.id,
    value === "true",
  );
  // fetch() asks for JSON; a plain form post gets a redirect and a message.
  if (req.accepts(["html", "json"]) === "json") return res.json(result);
  req.flash(
    "success",
    result.saved ? "Saved to your saved stays." : "Removed from your saved stays.",
  );
  return res.redirect(backPath(req, `/listings/${encodeURIComponent(req.params.id)}`));
};

// ---- Named lists, moving and notes (P10-T02) ----------------------------

const listPath = (id) => (id ? `/wishlists?list=${encodeURIComponent(id)}` : "/wishlists");

// Runs a list action: a refusal the member can fix (a name in use, a full
// list, a note too long) is shown on the page they came from; everything else
// is an error page.
async function act(req, res, { run, ok, back }) {
  try {
    const result = await run();
    req.flash("success", typeof ok === "function" ? ok(result) : ok);
    return res.redirect(typeof back === "function" ? back(result) : back);
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(typeof back === "function" ? back(null) : back);
    }
    throw err;
  }
}

module.exports.createList = (req, res) =>
  act(req, res, {
    run: () => lists.createList(req.user._id, req.body && req.body.name),
    ok: (list) => `List "${list.name}" created.`,
    back: (list) => (list ? listPath(list.id) : "/wishlists"),
  });

module.exports.renameList = (req, res) =>
  act(req, res, {
    run: () => lists.renameList(req.user._id, req.params.id, req.body && req.body.name),
    ok: "List renamed.",
    back: listPath(req.params.id),
  });

module.exports.deleteList = (req, res) =>
  act(req, res, {
    run: () => lists.deleteList(req.user._id, req.params.id),
    ok: (r) =>
      r.moved > 0
        ? `List deleted. Its ${r.moved} stay${r.moved === 1 ? " was" : "s were"} moved to your main list.`
        : "List deleted.",
    // a refusal keeps the member on the list they tried to delete
    back: (r) => (r ? "/wishlists" : listPath(req.params.id)),
  });

module.exports.moveItem = (req, res) =>
  act(req, res, {
    run: () =>
      lists.moveItem(req.user._id, {
        from: req.params.id,
        to: plain(req.body && req.body.to),
        listingId: req.params.listingId,
      }),
    ok: "Stay moved.",
    back: listPath(req.params.id),
  });

module.exports.setNote = (req, res) =>
  act(req, res, {
    run: () =>
      lists.setNote(req.user._id, {
        listId: req.params.id,
        listingId: req.params.listingId,
        note: req.body && req.body.note,
      }),
    ok: (r) => (r.note ? "Note saved." : "Note removed."),
    back: listPath(req.params.id),
  });

// ---- Saved searches ------------------------------------------------------

module.exports.searchesIndex = async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.render("wishlists/searches.ejs", {
    searches: await searches.list(req.user._id),
    pageTitle: "Saved searches",
    pageDescription: "The searches you saved on Dimora.",
  });
};

// The listings page posts its own state (hidden fields) plus a name. The
// query that is stored is built from that state by the server.
module.exports.saveSearch = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    await searches.save(req.user._id, { name: body.name, params: body });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(backPath(req, "/listings"));
    }
    throw err;
  }
  req.flash("success", "Search saved. Find it under Saved searches.");
  return res.redirect("/saved-searches");
};

module.exports.deleteSearch = async (req, res) => {
  await searches.remove(req.user._id, req.params.id);
  req.flash("success", "Saved search deleted.");
  return res.redirect("/saved-searches");
};

// ---- Share links (P10-T04) ------------------------------------------------

module.exports.share = (req, res) =>
  act(req, res, {
    run: () => shared.enableShare(req.user._id, req.params.id),
    ok: (r) => (r.created ? "Share link created. Anyone who has it can see this list." : "This list is already shared."),
    back: listPath(req.params.id),
  });

module.exports.revokeShare = (req, res) =>
  act(req, res, {
    run: () => shared.revokeShare(req.user._id, req.params.id),
    ok: "Sharing stopped. The old link no longer works.",
    back: listPath(req.params.id),
  });

// Public. Read-only; the link is the credential, so the page must not be
// indexed, cached or leaked through the Referer header.
module.exports.showShared = async (req, res) => {
  const data = await shared.viewShared(req.params.token);
  res.set({
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
  res.render("wishlists/shared.ejs", {
    ...data,
    pageTitle: data.name,
    pageDescription: "A list of stays shared on Dimora.",
  });
};
