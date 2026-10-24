// P14-T03: the moderation pages and the host's suspended-listing notice,
// rendered by the real EJS views (layout included). Everything typed by a
// member must come out escaped.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const { formatMoney } = require("../../src/utils/money");
const pagination = require("../../src/utils/pagination");

const ROOT = path.join(__dirname, "..", "..");
const NOW = new Date("2026-11-20T06:00:00.000Z");

function render(view, locals) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  Object.assign(a.locals, {
    fullTitle,
    metaDescription,
    formatMoney,
    pagination,
    imageUrl: (u) => u,
  });
  a.use((req, res, next) => {
    Object.assign(res.locals, {
      success: [],
      error: [],
      currUser: { _id: "x", username: "boss", role: "admin" },
      currentPath: "/",
      can: () => true,
      csrfToken: "tok",
      cspNonce: "n",
      mapPublicToken: "",
    });
    next();
  });
  a.get("/", (req, res) => res.render(view, locals));
  return request(a).get("/");
}

const row = (over = {}) => ({
  id: "64b7f0c2a1b2c3d4e5f60718",
  title: "Sea <b>house</b>",
  status: "published",
  place: "Goa, India",
  host: "asha",
  hostId: "64b7f0c2a1b2c3d4e5f60719",
  createdAt: NOW,
  openReports: 2,
  hiddenWithHost: false,
  reviewed: false,
  ...over,
});

describe("the queue page", () => {
  const result = (over = {}) => ({
    rows: [row()],
    page: 1,
    totalPages: 1,
    total: 1,
    filter: "reported",
    ...over,
  });

  test("tabs, the count, one row with escaped text and a link to the listing's page", async () => {
    const res = await render("admin/listings.ejs", { result: result() });
    expect(res.status).toBe(200);
    for (const tab of ["Reported", "New (not reviewed)", "Suspended"])
      expect(res.text).toContain(tab);
    expect(res.text).toMatch(
      /class="nav-link active" aria-current="page" href="\/admin\/listings\?filter=reported"/,
    );
    expect(res.text).toMatch(/data-queue-total>1 listing\./);
    expect(res.text).toContain(
      'href="/admin/listings/64b7f0c2a1b2c3d4e5f60718"',
    );
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("Sea <b>house</b>");
    expect(res.text).toContain('href="/admin/users/64b7f0c2a1b2c3d4e5f60719"');
    expect(res.text).toContain("2026-11-20");
  });

  test("a listing hidden with its host's account says so", async () => {
    const res = await render("admin/listings.ejs", {
      result: result({
        filter: "suspended",
        rows: [row({ status: "suspended", hiddenWithHost: true })],
      }),
    });
    expect(res.text).toContain("with the host's account");
  });

  test("an empty queue says there is nothing to do, per queue", async () => {
    const empty = { rows: [], total: 0 };
    expect(
      (
        await render("admin/listings.ejs", {
          result: result({ ...empty, filter: "reported" }),
        })
      ).text,
    ).toContain("No open reports about listings");
    expect(
      (
        await render("admin/listings.ejs", {
          result: result({ ...empty, filter: "new" }),
        })
      ).text,
    ).toContain("Every published listing has been reviewed");
    expect(
      (
        await render("admin/listings.ejs", {
          result: result({ ...empty, filter: "suspended" }),
        })
      ).text,
    ).toContain("No suspended listings");
  });
});

describe("one listing", () => {
  const history = [
    {
      createdAt: NOW,
      actor: { username: "boss" },
      action: "listing.suspend",
      reason: "Fake <i>photos</i>",
    },
  ];
  const summary = (over = {}) => ({
    id: "64b7f0c2a1b2c3d4e5f60718",
    title: "Sea <b>house</b>",
    status: "published",
    deleted: false,
    place: "Goa, India",
    nightlyMinor: 250000,
    currency: "INR",
    photos: 3,
    descriptionExcerpt: "Nice <script>alert(1)</script> place",
    hiddenWithHost: false,
    reviewedAt: null,
    suspendedAt: null,
    suspendedBy: "",
    suspendReason: "",
    host: {
      id: "64b7f0c2a1b2c3d4e5f60719",
      username: "asha",
      status: "active",
    },
    ...over,
  });
  const page = (over = {}, extra = {}) => ({
    page: { summary: summary(over), reports: [], history: [], ...extra },
  });

  test("a published listing: facts, escaped text, a suspend form with a required reason and the CSRF token, and mark reviewed", async () => {
    const res = await render("admin/listing.ejs", page());
    expect(res.status).toBe(200);
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).toContain(
      "Nice &lt;script&gt;alert(1)&lt;/script&gt; place",
    );
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("₹2,500");
    expect(res.text).toContain('href="/listings/64b7f0c2a1b2c3d4e5f60718"');
    expect(res.text).toContain(
      'action="/admin/listings/64b7f0c2a1b2c3d4e5f60718/suspend"',
    );
    expect(res.text).toMatch(
      /<textarea[^>]*name="reason"[^>]*minlength="5"[^>]*maxlength="500"[^>]*required/,
    );
    expect(res.text).toContain('name="_csrf" value="tok"');
    expect(res.text).toContain(
      'action="/admin/listings/64b7f0c2a1b2c3d4e5f60718/reviewed"',
    );
    expect(res.text).not.toContain("/restore");
    expect(res.text).toContain("Bookings already made are not cancelled");
  });

  test("open reports are listed with reporter, reason and the (escaped) details", async () => {
    const res = await render(
      "admin/listing.ejs",
      page(
        {},
        {
          reports: [
            {
              reporter: "ravi",
              reason: "Scam or fraud",
              details: "It is <b>fake</b>",
              createdAt: NOW,
            },
          ],
        },
      ),
    );
    expect(res.text).toContain("Open reports (1)");
    expect(res.text).toContain("Scam or fraud");
    expect(res.text).toContain("by ravi");
    expect(res.text).toContain("It is &lt;b&gt;fake&lt;/b&gt;");
    expect(res.text).toContain("Reports are closed in the reports queue");
  });

  test("a reviewed listing has no mark-reviewed form", async () => {
    const res = await render("admin/listing.ejs", page({ reviewedAt: NOW }));
    expect(res.text).not.toContain("/reviewed");
  });

  test("a suspended listing shows the suspension and a restore form, not a suspend form", async () => {
    const res = await render(
      "admin/listing.ejs",
      page(
        {
          status: "suspended",
          suspendedAt: NOW,
          suspendedBy: "boss",
          suspendReason: "Fake <i>photos</i>",
        },
        { history },
      ),
    );
    expect(res.text).toContain("data-suspension");
    expect(res.text).toContain("Fake &lt;i&gt;photos&lt;/i&gt;");
    expect(res.text).toContain(
      'action="/admin/listings/64b7f0c2a1b2c3d4e5f60718/restore"',
    );
    expect(res.text).not.toContain("/suspend");
    expect(res.text).toContain("listing.suspend");
  });

  test("a listing hidden with its host's account cannot be restored here", async () => {
    const res = await render(
      "admin/listing.ejs",
      page({ status: "suspended", hiddenWithHost: true }),
    );
    expect(res.text).toContain(
      "Reinstate the account".replace(
        "Reinstate the account",
        "published again when the account is reinstated",
      ),
    );
    expect(res.text).not.toContain("/restore");
  });

  test("a deleted listing offers no action", async () => {
    const res = await render("admin/listing.ejs", page({ deleted: true }));
    expect(res.text).toContain("The host deleted this listing.");
    expect(res.text).not.toContain("/suspend");
    expect(res.text).not.toContain("/reviewed");
  });

  test("a draft or unpublished listing cannot be suspended from here", async () => {
    for (const status of ["draft", "unpublished"]) {
      const res = await render("admin/listing.ejs", page({ status }));
      expect(res.text).not.toContain("/suspend");
    }
  });
});

describe("the host's status page for a suspended listing", () => {
  const listing = (over = {}) => ({
    _id: "64b7f0c2a1b2c3d4e5f60718",
    title: "Sea house",
    status: "suspended",
    moderation: { suspendReason: "The photos are <b>not</b> of this place" },
    ...over,
  });
  const readiness = { canPublish: true, checks: [], passed: 5, total: 5 };

  test("shows the moderators' reason (escaped), says guests cannot see it, and offers no publish button", async () => {
    const res = await render("host/status.ejs", {
      listing: listing(),
      readiness,
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-suspended-notice");
    expect(res.text).toContain("suspended by Dimora's moderators");
    expect(res.text).toContain(
      "The photos are &lt;b&gt;not&lt;/b&gt; of this place",
    );
    expect(res.text).toContain("Guests cannot see this listing.");
    expect(res.text).toContain("Suspended");
    expect(res.text).not.toContain("/publish");
    expect(res.text).not.toContain("/unpublish");
    expect(res.text).toContain(
      "Bookings that were already made are not cancelled",
    );
  });

  test("a listing hidden with the host's own suspended account says that instead of a moderator reason", async () => {
    const res = await render("host/status.ejs", {
      listing: listing({ hiddenByOwnerSuspension: true, moderation: {} }),
      readiness,
    });
    expect(res.text).toContain("because your account is suspended");
    expect(res.text).not.toContain("data-suspend-reason");
  });

  test("a suspended listing without a recorded reason still renders", async () => {
    const res = await render("host/status.ejs", {
      listing: listing({ moderation: undefined }),
      readiness,
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("data-suspend-reason");
  });

  test("other statuses are unchanged: a draft still has its publish button, a published listing its unpublish button", async () => {
    const draft = await render("host/status.ejs", {
      listing: listing({ status: "draft", moderation: undefined }),
      readiness,
    });
    expect(draft.text).toContain("/publish");
    expect(draft.text).not.toContain("data-suspended-notice");
    const live = await render("host/status.ejs", {
      listing: listing({ status: "published", moderation: undefined }),
      readiness,
    });
    expect(live.text).toContain("/unpublish");
  });
});
