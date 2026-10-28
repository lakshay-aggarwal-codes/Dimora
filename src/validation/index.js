const Joi = require("joi");

module.exports.listingSchema = Joi.object({
    listing: Joi.object({
        title: Joi.string().trim().required(),
        description: Joi.string().trim().required(),
        location: Joi.string().trim().required(),
        country: Joi.string().trim().required(),
        // Rupees, as typed in the form. The floor matches the model (INR 100).
        price: Joi.number().required().min(100).max(1000000),
        // The image is never read from the body: it is the uploaded file
        // (multer), so a submitted `listing[image]` text field is rejected.
    }).required(),
});

// A review is for one stay (P12-T01): the form sends the reservation id, a whole
// rating of 1 to 5 and a comment. Who may review which stay is decided by
// services/reviews.js, not here.
module.exports.reviewSchema = Joi.object({
    review: Joi.object({
        reservation: Joi.string().hex().length(24).required(),
        rating: Joi.number().integer().required().min(1).max(5),
        comment: Joi.string().trim().min(1).max(2000).required(),
    }).required(),
});

// ---- Signup (P02-T02) -------------------------------------------------------
const { isCommonPassword } = require("./commonPasswords");

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;


// The password rule, shared by signup and "change password" (P02-T04): length,
// not a common password, not the username or the email's name. The username
// and email come from the object being validated (signup) or from the Joi
// `context` option (change password, where the object has no username).
function passwordRule() {
    return Joi.string().min(PASSWORD_MIN).max(PASSWORD_MAX).required()
        .custom((value, helpers) => {
            if (value.length > PASSWORD_MAX) return value; // already refused for its length
            if (isCommonPassword(value)) return helpers.error("password.common");
            const { username, email } = { ...(helpers.prefs.context || {}), ...(helpers.state.ancestors[0] || {}) };
            const lower = value.toLowerCase();
            const localPart = typeof email === "string" ? email.split("@")[0].toLowerCase() : "";
            if (
                (typeof username === "string" && lower === username.trim().toLowerCase()) ||
                (localPart && lower === localPart)
            ) {
                return helpers.error("password.personal");
            }
            return value;
        })
        .messages({
            "any.required": "Choose a password.",
            "string.base": "Choose a password.",
            "string.empty": "Choose a password.",
            "string.min": `Password must be at least ${PASSWORD_MIN} characters.`,
            "string.max": `Password must be at most ${PASSWORD_MAX} characters.`,
            "password.common": "That password is too common. Choose a less predictable one.",
            "password.personal": "Password must not be the same as your username or email.",
        });
}

// The messages are written for the person filling in the form and are shown as
// they are (flash). Joi's own wording never reaches the page.
module.exports.signupSchema = Joi.object({
    username: Joi.string().trim().min(3).max(30).pattern(USERNAME_PATTERN).required()
        .messages({
            "any.required": "Choose a username.",
            "string.base": "Choose a username.",
            "string.empty": "Choose a username.",
            "string.min": "Username must be 3 to 30 characters.",
            "string.max": "Username must be 3 to 30 characters.",
            "string.pattern.base": "Username can only contain letters, numbers and underscores.",
        }),
    email: Joi.string().trim().lowercase().max(254).email({ tlds: { allow: false } }).required()
        .messages({
            "any.required": "Enter your email address.",
            "string.base": "Enter your email address.",
            "string.empty": "Enter your email address.",
            "string.max": "Enter a valid email address.",
            "string.email": "Enter a valid email address.",
        }),
    password: passwordRule(),
});

// Change password (P02-T04). Validate with `{ context: { username, email } }`.
// The current password is only checked for being present: it is verified
// against the stored hash, never against the strength rules.
module.exports.changePasswordSchema = Joi.object({
    currentPassword: Joi.string().max(PASSWORD_MAX).required().messages({
        "any.required": "Enter your current password.",
        "string.base": "Enter your current password.",
        "string.empty": "Enter your current password.",
        "string.max": "Enter your current password.",
    }),
    newPassword: passwordRule(),
    confirmPassword: Joi.string().empty("").required().valid(Joi.ref("newPassword")).messages({
        "any.required": "Type the new password again to confirm it.",
        "string.empty": "Type the new password again to confirm it.",
        "any.only": "The two new passwords do not match.",
    }),
}).custom((value, helpers) => {
    if (value.currentPassword === value.newPassword) return helpers.error("password.same");
    return value;
}).messages({ "password.same": "The new password must be different from the current one." });

// Delete account (P02-T04): the password again, and the word DELETE.
module.exports.deleteAccountSchema = Joi.object({
    password: Joi.string().max(PASSWORD_MAX).required().messages({
        "any.required": "Enter your password to delete your account.",
        "string.base": "Enter your password to delete your account.",
        "string.empty": "Enter your password to delete your account.",
        "string.max": "Enter your password to delete your account.",
    }),
    confirm: Joi.string().trim().valid("DELETE").required().messages({
        "any.required": "Type DELETE to confirm.",
        "string.base": "Type DELETE to confirm.",
        "string.empty": "Type DELETE to confirm.",
        "any.only": "Type DELETE to confirm.",
    }),
});

// Forgot password (P02-T05): only the address; the answer never says whether it is known.
module.exports.forgotPasswordSchema = Joi.object({
    email: Joi.string().trim().lowercase().max(254).email({ tlds: { allow: false } }).required()
        .messages({
            "any.required": "Enter your email address.",
            "string.base": "Enter your email address.",
            "string.empty": "Enter your email address.",
            "string.max": "Enter a valid email address.",
            "string.email": "Enter a valid email address.",
        }),
});

// Reset password (P02-T05). Validate with `{ context: { username, email } }`.
module.exports.resetPasswordSchema = Joi.object({
    token: Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).required().messages({
        "any.required": "This link is not valid.",
        "string.base": "This link is not valid.",
        "string.empty": "This link is not valid.",
        "string.pattern.base": "This link is not valid.",
    }),
    newPassword: passwordRule(),
    confirmPassword: Joi.string().empty("").required().valid(Joi.ref("newPassword")).messages({
        "any.required": "Type the new password again to confirm it.",
        "string.empty": "Type the new password again to confirm it.",
        "any.only": "The two passwords do not match.",
    }),
});

module.exports.USERNAME_PATTERN = USERNAME_PATTERN;
module.exports.PASSWORD_MIN = PASSWORD_MIN;
module.exports.PASSWORD_MAX = PASSWORD_MAX;
