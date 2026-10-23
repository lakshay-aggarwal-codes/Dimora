// /host/reservations: the host's inbox, and accepting or declining a request.
const { listInbox, respond } = require("../services/hostInbox");
const { ConflictError } = require("../utils/errors");

async function renderInbox(req, res, { status = 200, error } = {}) {
  const inbox = await listInbox({}, req.user._id);
  res.status(status).render("host/reservations.ejs", {
    ...inbox,
    problem: error || null,
    pageTitle: "Booking requests",
  });
}

module.exports.index = async (req, res) => {
  await renderInbox(req, res);
};

function answer(decision, doneMessage) {
  return async (req, res) => {
    try {
      await respond(
        {},
        {
          id: req.params.id,
          user: req.user,
          decision,
          reason: req.body ? req.body.reason : undefined,
        },
      );
    } catch (err) {
      // A booking that changed under the host (expired, answered, listing
      // suspended) is shown as a 409 on a fresh inbox, with the reason.
      if (err instanceof ConflictError)
        return renderInbox(req, res, { status: 409, error: err.message });
      throw err;
    }
    req.flash("success", doneMessage);
    res.redirect("/host/reservations");
  };
}

module.exports.accept = answer(
  "accept",
  "Request accepted. The dates stay booked and the guest will see it under Your trips.",
);
module.exports.decline = answer(
  "decline",
  "Request declined. The dates are free again.",
);
