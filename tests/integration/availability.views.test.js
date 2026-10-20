// P07-T03 without a database: the calendar page markup (rendered from the real
// service on in-memory fakes), the guards on the new routes, and the links to
// the calendar. The database-backed routes are in availability.db.test.js.
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { createAgent } = require("../helpers/agent");
const { createLedgerService } = require("../../src/services/ledger");
const { createAvailabilityService } = require("../../src/services/availability");
const { FakeStayNight, fakeId } = require("../helpers/fakeStayNight");
const { FakeAvailabilityBlock } = require("../helpers/fakeAvailabilityBlock");

const VIEWS = path.join(__dirname, "..", "..", "views");
const NOW = new Date("2026-10-20T06:00:00Z");
const isValidId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/.test(v);
const squash = (html) => html.replace(/\s+/g, " ").trim();

function setup() {
  const nights = new FakeStayNight();
  const blocks = new FakeAvailabilityBlock();
  const ledger = createLedgerService({ model: nights, newId: fakeId, isValidId });
  const service = createAvailabilityService({ ledger, blockModel: blocks, newId: fakeId });
  const listing = {
    _id: fakeId(),
    title: "Sea <script>alert(1)</script> view",
    timezone: "Asia/Kolkata",
    status: "published",
  };
  return { nights, blocks, ledger, service, listing };
}

async function renderCalendar({ service, listing }, { month = "2026-11", errors = {}, values = {} } = {}) {
  const calendar = await service.monthView(listing, month, { now: NOW });
  const { runs, truncated } = await service.listBlocks(listing, { now: NOW });
  return ejs.renderFile(path.join(VIEWS, "host", "calendar.ejs"), {
    layout: () => {},
    listing,
    calendar,
    runs,
    truncated,
    errors,
    values,
    noteMaxLength: 200,
    csrfToken: "tok123",
  });
}

describe("views compile", () => {
  test.each(["host/calendar.ejs", "host/status.ejs"])("%s", (file) => {
    const source = fs.readFileSync(path.join(VIEWS, file), "utf8");
    expect(() => ejs.compile(source, { filename: path.join(VIEWS, file) })).not.toThrow();
  });
});

describe("the calendar page", () => {
  test("a month grid: seven weekday headings, a caption, one cell per day", async () => {
    const html = await renderCalendar(setup());
    expect(html).toContain("November 2026");
    expect((html.match(/<th scope="col"/g) || []).length).toBe(7);
    expect(html).toContain('abbr="Monday">Mon');
    expect(html).toContain("<caption");
    expect((html.match(/class="cal-cell cal-(?!empty)/g) || []).length).toBe(30);
    expect((html.match(/cal-empty/g) || []).length).toBe(12); // 6 leading + 6 trailing blanks
  });

  test("the listing title is escaped everywhere", async () => {
    const html = await renderCalendar(setup());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Sea &lt;script&gt;alert(1)&lt;/script&gt; view");
  });

  test("a blocked night says so in words, not only in colour", async () => {
    const ctx = setup();
    await ctx.service.blockDates(ctx.listing, { from: "2026-11-03", through: "2026-11-04" }, { now: NOW });
    const html = await renderCalendar(ctx);
    expect(html).toContain("cal-blocked");
    expect(html).toContain('<span class="cal-state" aria-hidden="true">Blocked</span>');
    expect(html).toContain("Tuesday 3 November 2026: blocked by you");
  });

  test("reserved and requested nights are shown, with no guest or id in the page", async () => {
    const ctx = setup();
    const source = { kind: "reservation", id: fakeId() };
    await ctx.ledger.reserveNights(ctx.listing._id, [new Date("2026-11-10T00:00:00Z")], source);
    await ctx.ledger.reserveNights(
      ctx.listing._id,
      [new Date("2026-11-12T00:00:00Z")],
      { kind: "reservation", id: fakeId() },
      new Date("2026-10-21T06:00:00Z"),
      { now: NOW },
    );
    const html = await renderCalendar(ctx);
    expect(html).toContain("cal-reserved");
    expect(html).toContain("cal-requested");
    expect(html).toContain("Reserved");
    expect(html).toContain("Request");
    expect(html).not.toContain(source.id);
  });

  test("today is marked with aria-current in the right month", async () => {
    const html = await renderCalendar(setup(), { month: "2026-10" });
    expect(html).toContain('aria-current="date"');
    expect(html).toContain("Tuesday 20 October 2026: available, today");
    const other = await renderCalendar(setup(), { month: "2026-11" });
    expect(other).not.toContain('aria-current="date"');
  });

  test("month links keep the listing id; a missing neighbour is a disabled button, not a link", async () => {
    const ctx = setup();
    const html = await renderCalendar(ctx, { month: "2025-10" });
    expect(html).toContain(`href="/host/listings/${ctx.listing._id}/calendar?month=2025-11"`);
    expect(html).toContain('aria-disabled="true">Previous month');
    const last = await renderCalendar(ctx, { month: "2027-10" });
    expect(last).toContain('aria-disabled="true">Next month');
    expect(last).toContain("?month=2027-09");
  });

  test("the block form posts to the listing's own URL with a CSRF token and date limits", async () => {
    const ctx = setup();
    const html = squash(await renderCalendar(ctx));
    expect(html).toContain(`action="/host/listings/${ctx.listing._id}/calendar/blocks"`);
    expect(html).toContain(`action="/host/listings/${ctx.listing._id}/calendar/unblock"`);
    expect(html).toContain('name="_csrf" value="tok123"');
    expect(html).toContain('type="date"');
    expect(html).toContain('min="2026-10-20"');
    expect(html).toContain('max="2027-10-20"');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain('<input type="hidden" name="month" value="2026-11">');
  });

  test("every post form has its own CSRF token", async () => {
    const ctx = setup();
    await ctx.service.blockDates(ctx.listing, { from: "2026-11-03", through: "2026-11-04" }, { now: NOW });
    const html = await renderCalendar(ctx);
    const forms = (html.match(/<form /g) || []).length;
    const tokens = (html.match(/name="_csrf" value="tok123"/g) || []).length;
    expect(forms).toBe(3); // block, the one block's Unblock, "unblock only some dates"
    expect(tokens).toBe(forms);
  });

  test("an upcoming block is listed with its note (escaped) and an Unblock button for exactly its dates", async () => {
    const ctx = setup();
    await ctx.service.blockDates(
      ctx.listing,
      { from: "2026-11-03", through: "2026-11-05", note: "<img src=x onerror=alert(1)>" },
      { now: NOW },
    );
    const html = squash(await renderCalendar(ctx));
    expect(html).toContain("3 Nov 2026 to 5 Nov 2026");
    expect(html).toContain("(3 nights)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('<input type="hidden" name="from" value="2026-11-03">');
    expect(html).toContain('<input type="hidden" name="through" value="2026-11-05">');
  });

  test("no blocks: a plain sentence instead of a list", async () => {
    const html = await renderCalendar(setup());
    expect(html).toContain("You have not blocked any upcoming nights.");
    expect(html).not.toContain('class="cal-blocks"');
  });

  test("an error is announced (role=alert), escaped, and the typed values come back", async () => {
    const html = await renderCalendar(setup(), {
      errors: { block: "Enter the first night as a valid date <now>" },
      values: { from: "2026-11-03", through: "2026-11-01", note: 'a"b' },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("valid date &lt;now&gt;");
    expect(html).toContain('value="2026-11-03"');
    expect(html).toContain('value="a&#34;b"');
  });

  test("an unblock error opens the 'unblock only some dates' section", async () => {
    const html = await renderCalendar(setup(), { errors: { unblock: "Nights that have already passed cannot be changed." } });
    expect(html).toMatch(/<details class="cal-unblock" open>/);
    const closed = await renderCalendar(setup());
    expect(closed).not.toMatch(/<details class="cal-unblock" open>/);
  });
});

describe("the calendar routes need a signed-in user", () => {
  const id = "64b0f0f0f0f0f0f0f0f0aaaa";
  test.each([
    ["get", `/host/listings/${id}/calendar`],
    ["post", `/host/listings/${id}/calendar/blocks`],
    ["post", `/host/listings/${id}/calendar/unblock`],
  ])("anonymous %s %s -> /login", async (method, url) => {
    const res = await createAgent()[method](url).type("form").send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });
});

describe("the calendar is reachable from the host pages", () => {
  test("the status page links to it only for a published or unpublished listing", () => {
    const source = fs.readFileSync(path.join(VIEWS, "host", "status.ejs"), "utf8");
    expect(source).toContain("/calendar");
    expect(source).toMatch(/listing\.status === "published" \|\| listing\.status === "unpublished"/);
  });
});
