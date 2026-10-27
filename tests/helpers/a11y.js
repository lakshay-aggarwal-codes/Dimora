// Accessibility audit helpers (P18-T03): render a real view through the real
// layout (ejs-mate), load the HTML into jsdom and run axe-core on it. No
// browser and no database. jsdom has no layout engine, so axe's colour-contrast
// rule cannot run here: contrast is checked from the design tokens instead
// (tests/unit/contrast.test.js).
const path = require("node:path");
const express = require("express");
const ejsMate = require("ejs-mate");
const { JSDOM } = require("jsdom");
const axe = require("axe-core");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

const ROOT = path.join(__dirname, "..", "..");

const member = {
  _id: "64b0f0f0f0f0f0f0f0f0aaaa",
  username: "asha",
  displayName: "Asha",
  role: "member",
  status: "active",
  email: "asha@example.com",
};
const admin = {
  ...member,
  _id: "64b0f0f0f0f0f0f0f0f0bbbb",
  username: "boss",
  role: "admin",
};

function viewApp() {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "views"));
  app.engine("ejs", ejsMate);
  Object.assign(app.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
  return app;
}
const app = viewApp();

/** The HTML of one view with the layout around it. `user` null = signed out. */
function renderPage(
  view,
  locals = {},
  { user = member, path: currentPath = "/", flash = {} } = {},
) {
  const base = {
    success: flash.success || [],
    error: flash.error || [],
    currUser: user,
    currentPath,
    formatMoney,
    mapPublicToken: "",
    csrfToken: "tok",
    cspNonce: "nonce",
    can: (action, resource) => can(action, user, resource),
  };
  return new Promise((resolve, reject) => {
    app.render(view, { ...base, ...locals }, (err, html) =>
      err ? reject(err) : resolve(html),
    );
  });
}

// WCAG 2.0/2.1/2.2 A and AA, plus axe's best practices. The two rules that need
// a real layout are switched off here and covered elsewhere (see header).
const RUN_OPTIONS = {
  runOnly: {
    type: "tag",
    values: [
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ],
  },
  rules: {
    "color-contrast": { enabled: false },
    "color-contrast-enhanced": { enabled: false },
  },
};

/** Run axe on an HTML string. Returns the violations as plain, readable objects. */
async function audit(html, { rules = {} } = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas; axe probes for one
  window.eval(axe.source);
  const results = await window.axe.run(window.document, {
    ...RUN_OPTIONS,
    rules: { ...RUN_OPTIONS.rules, ...rules },
  });
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes
      .slice(0, 5)
      .map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 160) })),
  }));
  window.close();
  return violations;
}

/** Render a view and audit it in one go. */
async function auditView(view, locals, options) {
  return audit(await renderPage(view, locals, options));
}

/** A one-line description of violations for a failing assertion message. */
function describe(violations) {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => `${n.target}  ${n.html}`).join("\n    ")}`,
    )
    .join("\n");
}

module.exports = {
  renderPage,
  audit,
  auditView,
  describe,
  member,
  admin,
  JSDOM,
};
