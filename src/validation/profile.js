// The "edit my profile" form (P02-T03). Only these three fields are accepted;
// anything else in the request (an id, a role, an email) is refused, so the form
// can never be used to change more than it shows.
const Joi = require("joi");

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NO_CONTROL_CHARS = /^[^\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]*$/;

const profileSchema = Joi.object({
  displayName: Joi.string()
    .trim()
    .max(60)
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    .pattern(/^[^\u0000-\u001F\u007F]*$/)
    .allow("")
    .default("")
    .label("Display name")
    .messages({
      "string.max": "Display name must be 60 characters or fewer.",
      "string.pattern.base": "Display name cannot contain control characters.",
    }),
  // Line breaks are kept (as "\n"); other control characters are refused.
  bio: Joi.string()
    .trim()
    .max(500)
    .allow("")
    .default("")
    .custom((value) => value.replace(/\r\n?/g, "\n"))
    .pattern(NO_CONTROL_CHARS)
    .label("Bio")
    .messages({
      "string.max": "Bio must be 500 characters or fewer.",
      "string.pattern.base": "Bio cannot contain control characters.",
    }),
  removeAvatar: Joi.boolean()
    .truthy("on", "1", "true")
    .falsy("off", "0", "false", "")
    .default(false),
});

/**
 * @returns {{ value: object|undefined, errors: Record<string,string> }}
 */
function validateProfile(body) {
  const { error, value } = profileSchema.validate(body ?? {}, {
    abortEarly: false,
    errors: { wrap: { label: false } },
  });
  if (!error) return { value, errors: {} };
  const errors = {};
  for (const detail of error.details) {
    const field = detail.path[0] ?? "form";
    if (!errors[field]) errors[field] = detail.message;
  }
  return { value: undefined, errors };
}

module.exports = { validateProfile, profileSchema };
