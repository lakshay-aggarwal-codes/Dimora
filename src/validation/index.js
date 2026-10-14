const Joi = require("joi");

module.exports.listingSchema = Joi.object({
    listing: Joi.object({
        title: Joi.string().trim().required(),
        description: Joi.string().trim().required(),
        location: Joi.string().trim().required(),
        country: Joi.string().trim().required(),
        price: Joi.number().required().min(0),
        // The image is never read from the body: it is the uploaded file
        // (multer), so a submitted `listing[image]` text field is rejected.
    }).required(),
});

module.exports.reviewSchema = Joi.object({
    review: Joi.object({
        rating: Joi.number().required().min(1).max(5),
        comment: Joi.string().required(),
    }).required(),
}); 

// ---- Signup (P02-T02) -------------------------------------------------------
const { isCommonPassword } = require("./commonPasswords");

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

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
    password: Joi.string().min(PASSWORD_MIN).max(PASSWORD_MAX).required()
        .custom((value, helpers) => {
            if (isCommonPassword(value)) return helpers.error("password.common");
            const { username, email } = helpers.state.ancestors[0] || {};
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
        }),
});

module.exports.USERNAME_PATTERN = USERNAME_PATTERN;
module.exports.PASSWORD_MIN = PASSWORD_MIN;
module.exports.PASSWORD_MAX = PASSWORD_MAX;
