// P03-T03: every partial rendered with ordinary and awkward data. No database.
const path = require("node:path");
const ejs = require("ejs");
const { formatMoney } = require("../../src/utils/money");
const pagination = require("../../src/utils/pagination");

const PARTIALS = path.join(__dirname, "..", "..", "views", "partials");
const render = (name, locals = {}) =>
  ejs.renderFile(path.join(PARTIALS, `${name}.ejs`), {
    formatMoney,
    pagination,
    csrfToken: "tok123",
    ...locals,
  });
const squash = (html) => html.replace(/\s+/g, " ").trim();
const count = (html, re) => (html.match(re) || []).length;

describe("price", () => {
  test("shows formatted money with the unit", async () => {
    const html = squash(
      await render("price", { amountMinor: 250000, unit: "night" }),
    );
    expect(html).toContain('<span class="price-amount">₹2,500</span>');
    expect(html).toContain('<span class="price-unit">/ night</span>');
  });
  test("no price is 'Price not set', never NaN or undefined", async () => {
    for (const locals of [
      {},
      { amountMinor: null },
      { amountMinor: undefined },
    ]) {
      const html = await render("price", locals);
      expect(html).toContain("Price not set");
      expect(html).not.toMatch(/NaN|undefined|null/);
    }
  });
  test("zero is a real price", async () => {
    expect(await render("price", { amountMinor: 0 })).toContain("₹0");
  });
  test("the tax note is optional and escaped", async () => {
    expect(await render("price", { amountMinor: 100 })).not.toContain(
      "tax-info",
    );
    const html = await render("price", {
      amountMinor: 100,
      note: "<b>+18%</b>",
    });
    expect(html).toContain("&lt;b&gt;+18%&lt;/b&gt;");
  });
  test("another currency", async () => {
    expect(
      await render("price", { amountMinor: 1050, currency: "USD" }),
    ).toContain("$10.50");
  });
  test("a fractional amount is a bug and fails loudly", async () => {
    await expect(render("price", { amountMinor: 12.5 })).rejects.toThrow(
      /integer/,
    );
  });
});

describe("rating", () => {
  test("value, count and one sentence for screen readers", async () => {
    const html = squash(await render("rating", { rating: 4.46, count: 12 }));
    expect(html).toContain("Rated 4.5 out of 5 from 12 reviews");
    expect(html).toContain('<span class="rating-value">4.5</span>');
    expect(html).toContain('aria-hidden="true"');
  });
  test("singular review", async () => {
    expect(await render("rating", { rating: 5, count: 1 })).toContain(
      "from 1 review<",
    );
  });
  test.each([
    [{}],
    [{ rating: null, count: null }],
    [{ rating: null, count: 3 }],
    [{ rating: 4, count: 0 }],
    [{ rating: "4.5", count: 2 }],
    [{ rating: NaN, count: 2 }],
  ])("no usable rating %j -> 'No reviews yet'", async (locals) => {
    const html = await render("rating", locals);
    expect(html).toContain("No reviews yet");
    expect(html).not.toMatch(/NaN|undefined|null|Rated/);
  });
  test("out-of-range values are clamped to 0-5", async () => {
    expect(await render("rating", { rating: 9, count: 2 })).toContain(
      "Rated 5.0 out of 5",
    );
    expect(await render("rating", { rating: -2, count: 2 })).toContain(
      "Rated 0.0 out of 5",
    );
  });
  test("rating without a count still renders", async () => {
    const html = await render("rating", { rating: 4 });
    expect(html).toContain("Rated 4.0 out of 5");
    expect(html).not.toContain("from");
  });
});

describe("badge", () => {
  test("variant class and text", async () => {
    const html = await render("badge", {
      text: "Published",
      variant: "success",
    });
    expect(html).toContain('class="dim-badge dim-badge-success"');
    expect(html).toContain(">Published<");
  });
  test("unknown or injected variants fall back to neutral", async () => {
    for (const variant of [
      undefined,
      "pink",
      '"><script>',
      "danger onclick=x",
    ]) {
      const html = await render("badge", { text: "x", variant });
      expect(html).toContain("dim-badge-neutral");
      expect(html).not.toContain("<script>");
    }
  });
  test("text is escaped; no text is empty, not 'undefined'", async () => {
    expect(await render("badge", { text: "<i>hi</i>" })).toContain(
      "&lt;i&gt;hi&lt;/i&gt;",
    );
    expect(await render("badge", {})).not.toContain("undefined");
  });
});

describe("form-field", () => {
  const field = (extra) =>
    render("form-field", { id: "title", label: "Title", ...extra });

  test("label is tied to the input", async () => {
    const html = await field({});
    expect(html).toContain(
      '<label for="title" class="form-label">Title</label>',
    );
    expect(html).toMatch(
      /<input class="form-control" id="title" name="title" type="text"/,
    );
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("aria-invalid");
  });
  test("hint and error are referenced by aria-describedby", async () => {
    const html = await field({
      hint: "Shown to guests",
      error: "Title is required",
    });
    expect(html).toContain('aria-describedby="title-hint title-error"');
    expect(html).toContain('id="title-hint"');
    expect(html).toContain('id="title-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("form-control is-invalid");
  });
  test("only a hint -> only the hint id", async () => {
    expect(await field({ hint: "h" })).toContain(
      'aria-describedby="title-hint"',
    );
  });
  test("required adds the attribute and a hidden-from-readers asterisk", async () => {
    const html = await field({ required: true });
    expect(html).toMatch(/<input [^>]* required/);
    expect(html).toContain(
      '<span class="form-required" aria-hidden="true">*</span>',
    );
  });
  test("the value and every text are escaped", async () => {
    const html = await field({
      value: '"><script>alert(1)</script>',
      label: "<b>T</b>",
      hint: "<i>h</i>",
      error: "<u>e</u>",
      placeholder: '"x',
    });
    expect(html).not.toMatch(/<script>|<b>T|<i>h|<u>e/);
    expect(html).toContain("&#34;&gt;&lt;script&gt;");
    expect(html).toContain('placeholder="&#34;x"');
  });
  test("a password never gets its value back", async () => {
    const html = await field({
      id: "password",
      type: "password",
      label: "Password",
      value: "hunter2hunter2",
    });
    expect(html).toContain('type="password"');
    expect(html).not.toContain("hunter2");
  });
  test("textarea keeps its text inside the element", async () => {
    const html = await field({
      type: "textarea",
      value: "line1\nline2 </textarea><b>",
      attrs: { rows: 4 },
    });
    expect(html).toMatch(
      /<textarea [^>]*rows="4"[^>]*>line1\nline2 &lt;\/textarea&gt;&lt;b&gt;<\/textarea>/,
    );
  });
  test("select marks the chosen option", async () => {
    const html = await field({
      type: "select",
      id: "country",
      label: "Country",
      value: "IN",
      options: [
        { value: "IN", label: "India" },
        { value: "NP", label: "Nepal" },
      ],
    });
    expect(html).toContain('<select class="form-select"');
    expect(html).toContain('<option value="IN" selected>India</option>');
    expect(html).toContain('<option value="NP">Nepal</option>');
  });
  test("only allowed extra attributes pass through", async () => {
    const html = await field({
      attrs: {
        maxlength: 80,
        onfocus: "alert(1)",
        "x-evil": "1",
        pattern: '[a-z"]+',
      },
    });
    expect(html).toContain('maxlength="80"');
    expect(html).toContain('pattern="[a-z&#34;]+"');
    expect(html).not.toMatch(/onfocus|x-evil/);
  });
  test("an unknown type is a text input", async () => {
    expect(await field({ type: 'text" onfocus="x' })).toContain('type="text"');
  });
  test("a missing or unsafe id/label fails loudly", async () => {
    await expect(render("form-field", { label: "x" })).rejects.toThrow(/id/);
    await expect(
      render("form-field", { id: 'a" onfocus="x', label: "x" }),
    ).rejects.toThrow(/id/);
    await expect(render("form-field", { id: "a" })).rejects.toThrow(/label/);
  });
  test("a number 0 value is kept", async () => {
    expect(await field({ type: "number", value: 0 })).toContain('value="0"');
  });
});

describe("pagination", () => {
  const nav = (locals) =>
    render("pagination", { baseUrl: "/listings", ...locals });

  test("one page or none renders nothing", async () => {
    for (const totalPages of [0, 1, undefined, -3, "x"]) {
      expect((await nav({ page: 1, totalPages })).trim()).toBe("");
    }
  });
  test("middle page: links, current page and rel attributes", async () => {
    const html = squash(
      await nav({
        page: 5,
        totalPages: 10,
        query: { search: "goa", page: "5" },
      }),
    );
    expect(html).toContain('<nav aria-label="Pagination"');
    expect(html).toContain('href="/listings?search=goa&amp;page=4" rel="prev"');
    expect(html).toContain('href="/listings?search=goa&amp;page=6" rel="next"');
    expect(html).toContain('aria-current="page"');
    expect(count(html, /aria-current="page"/g)).toBe(1);
    expect(html).toContain(
      'href="/listings?search=goa"><span class="visually-hidden">Page </span>1</a>',
    );
    expect(html).toContain("&hellip;");
  });
  test("first page: Previous is not a link", async () => {
    const html = await nav({ page: 1, totalPages: 3 });
    expect(html).toMatch(
      /<span class="page-link" aria-disabled="true">Previous<\/span>/,
    );
    expect(html).not.toContain('rel="prev"');
    expect(html).toContain('rel="next"');
  });
  test("last page: Next is not a link", async () => {
    const html = await nav({ page: 3, totalPages: 3 });
    expect(html).toMatch(
      /<span class="page-link" aria-disabled="true">Next<\/span>/,
    );
    expect(html).not.toContain('rel="next"');
  });
  test("an out-of-range page is clamped", async () => {
    const html = await nav({ page: 99, totalPages: 3 });
    expect(count(html, /aria-current="page"/g)).toBe(1);
    expect(html).toMatch(
      /aria-current="page"><span class="visually-hidden">Page <\/span>3</,
    );
  });
  test("query values are escaped and an unsafe base becomes /", async () => {
    const html = await nav({
      page: 1,
      totalPages: 2,
      baseUrl: "//evil.com",
      query: { q: '"><script>' },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("evil.com");
    expect(html).toContain('href="/?q=%22%3E%3Cscript%3E&amp;page=2"');
  });
});

describe("empty-state", () => {
  test("title, message, icon and action", async () => {
    const html = await render("empty-state", {
      title: "No stays found",
      message: "Try other dates.",
      icon: "fa-house",
      actionHref: "/listings",
      actionLabel: "Clear filters",
    });
    expect(html).toContain('<h2 class="empty-state-title">No stays found</h2>');
    expect(html).toContain("Try other dates.");
    expect(html).toContain(
      'class="fa-solid fa-house empty-state-icon" aria-hidden="true"',
    );
    expect(html).toContain(
      '<a class="btn btn-dark" href="/listings">Clear filters</a>',
    );
  });
  test("title only", async () => {
    const html = await render("empty-state", { title: "Nothing here" });
    expect(html).not.toMatch(/<p|<a |<i /);
  });
  test("heading level is limited to 2-6", async () => {
    expect(
      await render("empty-state", { title: "x", headingLevel: 3 }),
    ).toContain("<h3 ");
    expect(
      await render("empty-state", { title: "x", headingLevel: 1 }),
    ).toContain("<h2 ");
    expect(
      await render("empty-state", { title: "x", headingLevel: "9<script>" }),
    ).toContain("<h2 ");
  });
  test("unsafe action links, icons and text are neutralised", async () => {
    const html = await render("empty-state", {
      title: "<b>t</b>",
      message: "<i>m</i>",
      icon: '"><script>',
      actionHref: "https://evil.com",
      actionLabel: "Go",
    });
    expect(html).not.toMatch(/<script>|<b>t|<i>m|evil\.com|<a /);
    expect(
      await render("empty-state", {
        title: "x",
        actionHref: "//evil.com",
        actionLabel: "Go",
      }),
    ).not.toContain("evil.com");
    expect(
      await render("empty-state", { title: "x", actionHref: "/ok" }),
    ).not.toContain("<a ");
  });
});

describe("confirm-modal", () => {
  const modal = (extra) =>
    render("confirm-modal", {
      id: "delete-listing",
      action: "/listings/abc",
      ...extra,
    });

  test("accessible Bootstrap modal with CSRF, cancel and confirm", async () => {
    const html = squash(
      await modal({
        title: "Delete this listing?",
        message: "This cannot be undone.",
        confirmLabel: "Delete",
        methodOverride: "DELETE",
      }),
    );
    expect(html).toContain(
      'class="modal fade" id="delete-listing" tabindex="-1" aria-labelledby="delete-listing-title" aria-hidden="true"',
    );
    expect(html).toContain(
      'id="delete-listing-title">Delete this listing?</h2>',
    );
    expect(html).toContain(
      '<form method="POST" action="/listings/abc?_method=DELETE">',
    );
    expect(html).toContain('name="_csrf" value="tok123"');
    expect(html).toContain('data-bs-dismiss="modal" aria-label="Close"');
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('class="btn btn-danger">Delete</button>');
    expect(html).toContain("This cannot be undone.");
  });
  test("defaults: plain POST, 'Are you sure?', Confirm", async () => {
    const html = squash(await modal({}));
    expect(html).toContain('action="/listings/abc"');
    expect(html).not.toContain("_method");
    expect(html).toContain("Are you sure?");
    expect(html).toContain(">Confirm</button>");
  });
  test("method override joins an existing query string; only known verbs", async () => {
    expect(await modal({ action: "/a?x=1", methodOverride: "put" })).toContain(
      'action="/a?x=1&amp;_method=PUT"',
    );
    expect(await modal({ methodOverride: "TRACE" })).not.toContain("_method");
  });
  test("an unsafe id or action fails loudly", async () => {
    await expect(render("confirm-modal", { action: "/a" })).rejects.toThrow(
      /id/,
    );
    await expect(
      render("confirm-modal", { id: 'x" onclick="y', action: "/a" }),
    ).rejects.toThrow(/id/);
    for (const action of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      undefined,
    ]) {
      await expect(
        render("confirm-modal", { id: "m", action }),
      ).rejects.toThrow(/action/);
    }
  });
  test("texts are escaped", async () => {
    const html = await modal({
      title: "<b>T</b>",
      message: "<script>x</script>",
    });
    expect(html).not.toMatch(/<b>T|<script>/);
  });
});

describe("listing-card", () => {
  const card = (item) => render("listing-card", { item });
  const full = {
    id: "66b0f0f0f0f0f0f0f0f0f0f0",
    title: "Seaside Cottage",
    imageUrl: "https://res.cloudinary.com/x/a.jpg",
    location: "Goa",
    country: "India",
    priceMinor: 450000,
    currency: "INR",
    taxNote: "+18% GST",
  };

  test("a full listing", async () => {
    const html = squash(await card(full));
    expect(html).toContain('href="/listings/66b0f0f0f0f0f0f0f0f0f0f0"');
    expect(html).toContain('src="https://res.cloudinary.com/x/a.jpg"');
    expect(html).toContain('class="card-img-top listing-card-img" alt=""');
    expect(html).toContain(">Seaside Cottage</b>");
    expect(html).toContain("Goa, India");
    expect(html).toContain("₹4,500");
    expect(html).toContain("/ night");
    expect(html).toContain('<i class="tax-info">+18% GST</i>');
    expect(html).not.toContain("listing-card-rating");
  });
  test("no image uses the stock photo; no price says so", async () => {
    const html = await card({ id: "a1", title: "T" });
    expect(html).toContain("images.unsplash.com");
    expect(html).toContain("Price not set");
    expect(html).not.toMatch(/undefined|null|NaN/);
  });
  test("a very long title is in the page whole (CSS cuts it)", async () => {
    const title = "Very long title ".repeat(30).trim();
    const html = await card({ ...full, title });
    expect(html).toContain(title);
    expect(html).toContain("listing-card-title");
  });
  test("location parts are optional", async () => {
    expect(await card({ ...full, location: "", country: "India" })).toContain(
      ">India<",
    );
    expect(await card({ ...full, location: "", country: "" })).not.toContain(
      "listing-card-where",
    );
  });
  test("with a rating the rating partial is used; a null rating leaves it out", async () => {
    const html = await card({ ...full, rating: 4.8, reviewCount: 3 });
    expect(html).toContain("Rated 4.8 out of 5 from 3 reviews");
    expect(
      await card({ ...full, rating: null, reviewCount: null }),
    ).not.toContain("rating");
  });
  test("everything is escaped; the id is URL-encoded", async () => {
    const html = await card({
      id: 'a"/><script>',
      title: "<script>x</script>",
      imageUrl: '"><script>',
      location: "<b>",
      country: "<i>",
      priceMinor: 100,
      taxNote: "<u>",
    });
    expect(html).not.toMatch(/<script>|<b>|<i>|<u>/);
    expect(html).toContain('href="/listings/a%22%2F%3E%3Cscript%3E"');
  });
  test("zero price shows ₹0, not 'Price not set'", async () => {
    expect(await card({ ...full, priceMinor: 0 })).toContain("₹0");
  });
});
