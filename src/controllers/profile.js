// Profile pages (P02-T03): the public page /users/:id and the owner's own edit
// form /account/profile. The edit form has no id in its URL: it always changes
// the signed-in user, so nobody can edit anybody else's profile.
const User = require("../models/user");
const Listing = require("../models/listing");
const Review = require("../models/review");
const { loadPublicProfile } = require("../services/profile");
const { loadTrust } = require("../services/trust");
const Reservation = require("../models/reservation");
const { validateProfile } = require("../validation/profile");
const { assertValidImage, UploadFailedError } = require("../services/images");
const { uploadBuffer, deleteImage } = require("../config/cloudinary");
const { NotFoundError, ValidationError } = require("../utils/errors");

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const BIO_MAX = 500;
const NAME_MAX = 60;

module.exports.show = async (req, res) => {
  const profile = await loadPublicProfile(
    { User, Listing, Review },
    req.params.id,
  );
  if (!profile) throw new NotFoundError("That profile does not exist.");
  // Facts the system knows (P12-T05). A failure here must not take the page down.
  let trust = null;
  try {
    trust = await loadTrust({ User, Reservation }, profile.id);
  } catch {
    trust = null;
  }
  res.render("users/profile.ejs", {
    profile,
    trust,
    isOwn: Boolean(req.user && String(req.user._id) === profile.id),
    pageTitle: profile.displayName,
    pageDescription: `${profile.displayName} on Dimora.`,
  });
};

function renderEdit(res, user, { values, errors = {}, formError, status = 200 } = {}) {
  res.status(status).render("account/profile.ejs", {
    account: {
      id: String(user._id),
      avatarUrl: user.avatar && user.avatar.url ? user.avatar.url : null,
      displayName: user.displayName || user.username,
    },
    values: values ?? { displayName: user.displayName || "", bio: user.bio || "" },
    errors,
    formError,
    limits: { bio: BIO_MAX, name: NAME_MAX, avatarMb: AVATAR_MAX_BYTES / (1024 * 1024) },
    pageTitle: "Edit your profile",
    pageDescription: "Change your display name, photo and bio.",
  });
}

module.exports.editForm = (req, res) => renderEdit(res, req.user);

module.exports.update = async (req, res) => {
  const user = req.user;
  const { value, errors } = validateProfile(req.body);
  if (!value) {
    return renderEdit(res, user, { values: req.body, errors, status: 400 });
  }

  // The profile photo: a real image (checked by its bytes) of at most 2 MB.
  let uploaded;
  if (req.file) {
    try {
      assertValidImage(req.file);
      if (req.file.buffer.length > AVATAR_MAX_BYTES) {
        throw new ValidationError("Your photo is too large (maximum 2 MB).");
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        return renderEdit(res, user, {
          values: req.body,
          formError: err.message,
          status: 400,
        });
      }
      throw err;
    }
    try {
      const result = await uploadBuffer(req.file.buffer);
      uploaded = { url: result.secure_url, filename: result.public_id };
    } catch (err) {
      throw new UploadFailedError(undefined, { cause: err });
    }
  }

  let previous;
  user.displayName = value.displayName; // empty falls back to the username (User model)
  user.bio = value.bio;
  if (uploaded) {
    previous = user.avatar && user.avatar.filename;
    user.set("avatar", uploaded);
  } else if (value.removeAvatar && user.avatar && user.avatar.url) {
    previous = user.avatar.filename;
    user.set("avatar.url", undefined);
    user.set("avatar.filename", undefined);
  }

  try {
    await user.save();
  } catch (err) {
    if (uploaded) await deleteImage(uploaded.filename, req.log); // no orphan
    throw err;
  }
  if (previous) await deleteImage(previous, req.log);

  req.flash("success", "Your profile has been updated.");
  res.redirect("/account/profile");
};
