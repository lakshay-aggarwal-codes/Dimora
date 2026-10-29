// Emailing notifications and the member's email preferences (P11-T05).
//
// Rules (docs/EMAIL.md):
//   - The in-app notification is always stored (notificationEvents.js); this
//     only decides whether a COPY is also emailed.
//   - Only to an active account with a CONFIRMED address (emailVerifiedAt).
//   - A group the member switched off is not emailed; a group that is
//     `essential` always is, and says so in the footer.
//   - Every optional email has a "stop these emails" link: a signed address
//     (HMAC of member + group, keyed from SESSION_SECRET). Opening it shows a
//     button; the POST switches the group off, so a mail scanner that opens
//     links changes nothing.
//   - Sending is best effort: a failure is logged (never the address or the
//     link) and never reaches the booking or admin action that caused it.
const crypto = require("node:crypto");
const { GROUPS, GROUP_BY_KEY, GROUP_OF_TYPE, TOGGLEABLE } = require("../config/notificationPrefs");
const templates = require("../emails/templates");

const TOKEN_PATTERN = /^[0-9a-f]{24}\.[a-z]{3,20}\.[A-Za-z0-9_-]{43}$/;

const keyFor = (secret) => crypto.createHash("sha256").update(`dimora-unsubscribe:${secret}`).digest();
const mac = (secret, userId, group) =>
  crypto.createHmac("sha256", keyFor(secret)).update(`${userId}.${group}`).digest("base64url");

/** The token in a "stop these emails" link. */
function unsubscribeToken({ userId, group, secret }) {
  return `${userId}.${group}.${mac(secret, userId, group)}`;
}

/** @returns {{ userId: string, group: string } | null} null for anything not made by us */
function readUnsubscribeToken(token, secret) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const [userId, group, given] = token.split(".");
  const want = Buffer.from(mac(secret, userId, group));
  const got = Buffer.from(given);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const def = GROUP_BY_KEY.get(group);
  return def && !def.essential ? { userId, group } : null;
}

/** Does this member want the email copy of a notification type? */
function wantsEmail(user, type) {
  const group = GROUP_OF_TYPE.get(type);
  if (!group) return false;
  if (group.essential) return true;
  const chosen = user.notificationEmail && user.notificationEmail[group.key];
  return typeof chosen === "boolean" ? chosen : group.default;
}

/** The groups with what this member has chosen, for the settings page. */
function effectivePrefs(user) {
  return GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    description: g.description,
    essential: g.essential,
    enabled: g.essential ? true : wantsEmail(user, g.types[0]),
  }));
}

const absolute = (baseUrl, path) => {
  const base = String(baseUrl).replace(/\/+$/, "");
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? `${base}${path}` : base;
};

/**
 * @param {object} deps
 * @param {{ send: Function }} deps.emailService
 * @param {string} deps.baseUrl  public address of the site
 * @param {string} deps.secret   SESSION_SECRET (keys the unsubscribe links)
 * @param {{ warn?: Function }} [deps.logger]
 * @param {object} [deps.UserModel]
 */
function createNotificationMailer({ emailService, baseUrl, secret, logger = {}, UserModel } = {}) {
  const Users = () => UserModel || require("../models/user");

  /**
   * Emails the copy of one stored notification if the member allows it.
   * Never throws. @returns {Promise<{ sent: boolean, reason?: string }>}
   */
  async function deliver({ userId, type, payload }) {
    try {
      const group = GROUP_OF_TYPE.get(type);
      if (!group) return { sent: false, reason: "no_group" };
      const user = await Users()
        .findById(userId)
        .select("email username displayName status emailVerifiedAt notificationEmail")
        .lean();
      if (!user || user.status !== "active") return { sent: false, reason: "no_account" };
      if (!user.emailVerifiedAt) return { sent: false, reason: "unconfirmed" };
      if (!wantsEmail(user, type)) return { sent: false, reason: "switched_off" };
      const id = String(user._id);
      const unsubscribe = group.essential
        ? undefined
        : absolute(baseUrl, `/email/unsubscribe/${unsubscribeToken({ userId: id, group: group.key, secret })}`);
      const message = templates.notification({
        name: user.displayName || user.username,
        title: payload.title,
        body: payload.body,
        link: absolute(baseUrl, payload.url),
        groupLabel: group.label,
        unsubscribeLink: unsubscribe,
      });
      await emailService.send({
        to: user.email,
        ...message,
        ...(unsubscribe ? { headers: { "List-Unsubscribe": `<${unsubscribe}>` } } : {}),
      });
      return { sent: true };
    } catch (err) {
      if (logger.warn) logger.warn({ type, err: { name: err && err.name, message: err && err.message } }, "notification email was not sent");
      return { sent: false, reason: "failed" };
    }
  }

  return { deliver };
}

/**
 * Saves the member's choices. Only the groups they may switch off are read;
 * a group missing from `input` counts as switched off (an unchecked box).
 */
async function savePrefs(userId, input, { UserModel } = {}) {
  const Users = UserModel || require("../models/user");
  const body = input && typeof input === "object" ? input : {};
  const set = {};
  for (const key of TOGGLEABLE) set[`notificationEmail.${key}`] = body[key] === "on" || body[key] === true;
  await Users.updateOne({ _id: userId }, { $set: set });
  return set;
}

/** Uses an unsubscribe token. @returns {Promise<{ ok: boolean, group?: object }>} */
async function unsubscribe(token, secret, { UserModel } = {}) {
  const parsed = readUnsubscribeToken(token, secret);
  if (!parsed) return { ok: false };
  const Users = UserModel || require("../models/user");
  const result = await Users.updateOne(
    { _id: parsed.userId, status: "active" },
    { $set: { [`notificationEmail.${parsed.group}`]: false } },
  );
  const matched = result.matchedCount !== undefined ? result.matchedCount : result.n;
  return matched ? { ok: true, group: GROUP_BY_KEY.get(parsed.group) } : { ok: false };
}

module.exports = {
  createNotificationMailer,
  unsubscribeToken,
  readUnsubscribeToken,
  wantsEmail,
  effectivePrefs,
  savePrefs,
  unsubscribe,
  TOKEN_PATTERN,
};
