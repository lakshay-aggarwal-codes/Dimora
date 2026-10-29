// The text of the emails (P02-T05). Each function returns { subject, text, html }.
// Names and links are escaped in the HTML part; the subject is fixed text.
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function wrap(bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222">${bodyHtml}<p style="color:#666;font-size:13px">Dimora is a college project. If you did not expect this email you can ignore it.</p></div>`;
}

function button(link, label) {
  return `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#212529;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(label)}</a></p><p style="font-size:14px">Or paste this address into your browser:<br>${escapeHtml(link)}</p>`;
}

function verifyEmail({ name, link, hours }) {
  return {
    subject: "Confirm your email address for Dimora",
    text: `Hi ${name},\n\nConfirm that this is your email address by opening this link (valid for ${hours} hours):\n\n${link}\n\nYou need a confirmed address to publish a listing or book a stay.\n\nIf you did not create a Dimora account you can ignore this email.`,
    html: wrap(
      `<p>Hi ${escapeHtml(name)},</p><p>Confirm that this is your email address. The link is valid for ${escapeHtml(hours)} hours.</p>${button(link, "Confirm my email")}<p>You need a confirmed address to publish a listing or book a stay.</p>`,
    ),
  };
}

function resetPassword({ name, link, minutes }) {
  return {
    subject: "Reset your Dimora password",
    text: `Hi ${name},\n\nSomeone asked to reset the password of your Dimora account. To choose a new one, open this link (valid for ${minutes} minutes, works once):\n\n${link}\n\nIf this was not you, ignore this email: your password has not changed.`,
    html: wrap(
      `<p>Hi ${escapeHtml(name)},</p><p>Someone asked to reset the password of your Dimora account. The link is valid for ${escapeHtml(minutes)} minutes and works once.</p>${button(link, "Choose a new password")}<p>If this was not you, ignore this email: your password has not changed.</p>`,
    ),
  };
}

function passwordChanged({ name }) {
  return {
    subject: "Your Dimora password was changed",
    text: `Hi ${name},\n\nThe password of your Dimora account was just changed using a reset link. If this was you, there is nothing to do. If it was not, reset your password again and contact the site's administrator.`,
    html: wrap(
      `<p>Hi ${escapeHtml(name)},</p><p>The password of your Dimora account was just changed using a reset link.</p><p>If this was you, there is nothing to do. If it was not, reset your password again and contact the site's administrator.</p>`,
    ),
  };
}

/**
 * An email copy of an in-app notification (P11-T05). `link` is an absolute
 * address on this site; `unsubscribeLink` is omitted for essential messages.
 */
function notification({ name, title, body, link, groupLabel, unsubscribeLink }) {
  const text = [
    `Hi ${name},`,
    "",
    title,
    ...(body ? ["", body] : []),
    "",
    `Open it on Dimora: ${link}`,
    "",
    unsubscribeLink
      ? `You get this email because of your "${groupLabel}" notification setting. Stop these emails: ${unsubscribeLink}`
      : `You get this email because it is about something you run on Dimora (${groupLabel}). It cannot be turned off.`,
  ].join("\n");
  const footer = unsubscribeLink
    ? `<p style="color:#666;font-size:13px">You get this email because of your &ldquo;${escapeHtml(groupLabel)}&rdquo; notification setting. <a href="${escapeHtml(unsubscribeLink)}">Stop these emails</a>.</p>`
    : `<p style="color:#666;font-size:13px">You get this email because it is about something you run on Dimora (${escapeHtml(groupLabel)}). It cannot be turned off.</p>`;
  return {
    subject: String(title).replace(/[\r\n]+/g, " ").slice(0, 150),
    text,
    html: wrap(
      `<p>Hi ${escapeHtml(name)},</p><p><strong>${escapeHtml(title)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ""}${button(link, "Open on Dimora")}${footer}`,
    ),
  };
}

module.exports = { verifyEmail, resetPassword, passwordChanged, notification, escapeHtml };
