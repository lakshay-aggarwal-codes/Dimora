// P03-T02: the layout shell, without a database. Pages that need data stub the
// model; the navbar/flash/footer partials are also rendered directly so the
// logged-in variants can be checked.
const path = require("node:path");
const ejs = require("ejs");
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { stubListings } = require("../helpers/listingsStub");

const INCLUDES = path.join(__dirname, "..", "..", "views", "includes");
const render = (name, locals) =>
  ejs.renderFile(path.join(INCLUDES, `${name}.ejs`), locals);

const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) || [])[1];
const count = (html, re) => (html.match(re) || []).length;

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

afterEach(() => jest.restoreAllMocks());

async function pages() {
  stubListings([]);
  const doc = new Listing(
    buildListingData({
      title: "Seaside Cottage",
      description: "A quiet cottage by the sea.",
    }),
  );
  stubFindById(doc);
  const agent = createAgent();
  const get = async (url) => (await agent.get(url)).text;
  return {
    login: await get("/login"),
    signup: await get("/signup"),
    privacy: await get("/privacy"),
    terms: await get("/terms"),
    notFound: await get("/no-such-page"),
    listings: await get("/listings"),
    show: await get(`/listings/${doc._id}`),
  };
}

describe("document structure", () => {
  let html;
  beforeAll(async () => {
    html = await pages();
  });

  test("every page has one header, one main, one footer and a labelled main nav", () => {
    for (const [name, page] of Object.entries(html)) {
      expect({ name, n: count(page, /<header[\s>]/g) }).toEqual({ name, n: 1 });
      expect({ name, n: count(page, /<main[\s>]/g) }).toEqual({ name, n: 1 });
      expect({ name, n: count(page, /<footer[\s>]/g) }).toEqual({ name, n: 1 });
      expect(page).toContain(
        '<nav class="navbar navbar-expand-md" aria-label="Main">',
      );
      expect(page).toContain('<nav aria-label="Footer">');
    }
  });

  test("the skip link is the first thing in <body> and points at <main id=main>", () => {
    for (const page of Object.values(html)) {
      const body = page.slice(page.indexOf("<body>"));
      expect(
        body
          .replace(/\s+/g, " ")
          .startsWith(
            '<body> <a class="visually-hidden-focusable skip-link" href="#main">Skip to main content</a>',
          ),
      ).toBe(true);
      expect(page).toMatch(/<main id="main" class="container" tabindex="-1">/);
    }
  });

  test("the skip link comes before the navbar in the source (so it is the first Tab stop)", () => {
    const page = html.login;
    expect(page.indexOf("skip-link")).toBeLessThan(
      page.indexOf('<nav class="navbar'),
    );
  });

  test("the brand link has a text name, not only an icon", () => {
    expect(html.login).toMatch(
      /<a class="navbar-brand" href="\/">[\s\S]*?<span class="brand-name">Dimora<\/span>/,
    );
    expect(html.login).toMatch(/fa-compass" aria-hidden="true"/);
  });

  test("the menu toggle is a labelled, controlled button", () => {
    const toggle = html.login.match(
      /<button class="navbar-toggler"[\s\S]*?>/,
    )[0];
    expect(toggle).toContain('aria-controls="site-nav"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-label="Toggle navigation"');
    expect(html.login).toContain('id="site-nav"');
  });

  test("the search field has a real label", () => {
    expect(html.login).toMatch(
      /<label class="visually-hidden" for="nav-search">Search destinations<\/label>/,
    );
    expect(html.login).toContain('id="nav-search"');
  });

  test("nothing in the navigation is removed from the tab order", () => {
    const header = html.login.slice(
      html.login.indexOf("<header"),
      html.login.indexOf("</header>"),
    );
    expect(header).not.toMatch(/tabindex="-1"/);
    expect(header).not.toMatch(/\sdisabled[\s>=]/);
  });

  test("a visitor sees Sign up and Log in, and no account menu or bell", () => {
    expect(html.login).toContain('href="/signup"');
    expect(html.login).toContain('href="/login"');
    expect(html.login).not.toContain("account-menu");
    expect(html.login).not.toContain("data-placeholder");
    expect(html.login).not.toContain("Logout");
  });

  test("aria-current marks the current page, and only it", () => {
    expect(count(html.login, /aria-current="page"/g)).toBe(1);
    expect(html.login).toMatch(/href="\/login" aria-current="page"/);
    expect(html.signup).toMatch(/href="\/signup" aria-current="page"/);
    expect(html.listings).toMatch(/href="\/listings" aria-current="page"/);
    expect(count(html.privacy, /aria-current="page"/g)).toBe(0);
  });

  test("the footer has real links and no fake social icons", () => {
    for (const href of [
      "/listings",
      "/host/listings/new",
      "/about",
      "/privacy",
      "/terms",
      "/login",
      "/signup",
    ]) {
      expect(html.login).toContain(`<a href="${href}">`);
    }
    expect(html.login).not.toMatch(/fa-facebook|fa-instagram|fa-linkedin/);
    expect(html.login).toContain(
      `&copy; ${new Date().getFullYear()} Dimora, a college project`,
    );
  });
});

describe("page titles and descriptions", () => {
  let html;
  beforeAll(async () => {
    html = await pages();
  });

  test("each page has its own title", () => {
    expect(titleOf(html.login)).toBe("Log in | Dimora");
    expect(titleOf(html.signup)).toBe("Sign up | Dimora");
    expect(titleOf(html.privacy)).toBe("Privacy Policy | Dimora");
    expect(titleOf(html.terms)).toBe("Terms of Service | Dimora");
    expect(titleOf(html.notFound)).toMatch(/^404 /);
    expect(titleOf(html.listings)).toBe("Explore stays | Dimora");
    expect(titleOf(html.show)).toBe("Seaside Cottage | Dimora");
  });

  test("no two pages share a title", () => {
    const titles = Object.values(html).map(titleOf);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("every page has a meta description; the listing page uses the listing's", () => {
    for (const page of Object.values(html)) {
      expect(page).toMatch(/<meta name="description" content="[^"]{20,}">/);
    }
    expect(html.show).toContain(
      '<meta name="description" content="A quiet cottage by the sea.">',
    );
  });

  test("a title and description with markup are escaped, not injected", async () => {
    const doc = new Listing(
      buildListingData({
        title: "<script>alert(1)</script>",
        description: 'x" onload="alert(1)',
      }),
    );
    stubFindById(doc);
    const res = await createAgent().get(`/listings/${doc._id}`);
    expect(titleOf(res.text)).toContain("&lt;script&gt;");
    expect(res.text).not.toContain("<title><script>");
    expect(res.text).not.toContain('content="x" onload');
  });
});

describe("flash messages", () => {
  test("a success message is a polite status with a labelled close button", async () => {
    stubListings([]);
    const agent = createAgent();
    const out = await agent.post("/logout");
    expect(out.status).toBe(302);
    const page = (await agent.get("/listings")).text;
    expect(page).toMatch(
      /<div class="alert alert-success[^"]*" role="status">\s*You are logged out/,
    );
    expect(page).toContain('aria-label="Close"');
    expect(page).not.toContain('role="alert"');
  });

  test("an error message is an alert", async () => {
    const agent = createAgent();
    await agent
      .post("/signup")
      .type("form")
      .send({ username: "a", email: "x", password: "y" });
    const page = (await agent.get("/signup")).text;
    expect(page).toMatch(/<div class="alert alert-danger[^"]*" role="alert">/);
  });

  test("each message gets its own alert, and markup in a message is escaped", async () => {
    const html = await render("flash", {
      success: ["one", "two"],
      error: ["<b>bad</b>"],
    });
    expect(count(html, /role="status"/g)).toBe(2);
    expect(count(html, /role="alert"/g)).toBe(1);
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).not.toContain("<b>bad</b>");
  });

  test("no messages, no markup", async () => {
    const html = await render("flash", { success: [], error: [] });
    expect(html.trim()).toBe("");
    expect((await render("flash", {})).trim()).toBe("");
  });
});

describe("logged-in navbar", () => {
  const user = { username: "ann_01" };
  const navbar = (extra = {}) =>
    render("navbar", {
      currUser: user,
      currentPath: "/listings",
      csrfToken: "tok",
      ...extra,
    });

  test("has a notification placeholder that stays keyboard-focusable", async () => {
    const html = await navbar();
    const bell = html.match(
      /<button type="button" class="nav-link nav-icon-btn" aria-disabled="true"[\s\S]*?<\/button>/,
    )[0];
    expect(bell).toContain('data-placeholder="notifications"');
    expect(bell).toContain("Notifications (coming soon)");
    expect(bell).not.toMatch(/\sdisabled[\s>=]/);
  });

  test("has an account menu with a Logout form (POST, CSRF token) and the username", async () => {
    const html = await navbar();
    expect(html).toContain('data-bs-toggle="dropdown"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-labelledby="account-menu"');
    expect(html).toMatch(
      /<form action="\/logout" method="POST">[\s\S]*?name="_csrf"[\s\S]*?Logout/,
    );
    expect(html).not.toContain('href="/logout"');
    expect(html).toContain("ann_01");
  });

  test("shows no Sign up or Log in", async () => {
    const html = await navbar();
    expect(html).not.toContain('href="/signup');
    expect(html).not.toContain('href="/login');
  });

  test("the username is escaped", async () => {
    const html = await navbar({
      currUser: { username: "<img src=x onerror=alert(1)>" },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("the footer hides Log in / Sign up for a signed-in user", async () => {
    const html = await render("footer", { currUser: user });
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('href="/login"');
    expect(html).toContain('href="/privacy"');
  });
});
