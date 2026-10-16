// P03-T04: the repaired pages through the real app and views. No database:
// models are stubbed like in listings.show.test.js; the logged-in-only pages
// (new, edit) are rendered through the app's view engine.
const { createAgent, createTestApp } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

afterEach(() => jest.restoreAllMocks());

const count = (html, re) => (html.match(re) || []).length;
const OID = "507f1f77bcf86cd799439011";

function renderView(view, locals = {}) {
  const app = createTestApp();
  return new Promise((resolve, reject) => {
    app.render(
      view,
      {
        currUser: null,
        csrfToken: "tok123",
        currentPath: "/",
        success: [],
        error: [],
        ...locals,
      },
      (err, html) => (err ? reject(err) : resolve(html)),
    );
  });
}

/** A detail-page listing as a plain object, so reviews can carry authors. */
function plainListing(overrides = {}) {
  const data = buildListingData({ title: "Seaside Cottage" });
  return {
    ...data,
    _id: OID,
    id: OID,
    owner: { username: "host1" },
    reviews: [],
    ...overrides,
  };
}

function stubShow(listing) {
  const query = {
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(listing).then(resolve, reject),
  };
  jest.spyOn(Listing, "findById").mockReturnValue(query);
}

describe("every page has one h1 and no fixed offsets", () => {
  test("login, signup, privacy, 404, listings and a detail page", async () => {
    jest
      .spyOn(Listing, "find")
      .mockResolvedValue([new Listing(buildListingData())]);
    stubShow(plainListing());
    const agent = createAgent();
    for (const url of [
      "/login",
      "/signup",
      "/privacy",
      "/terms",
      "/no-such-page",
      "/listings",
      `/listings/${OID}`,
    ]) {
      const html = (await agent.get(url)).text;
      expect({ url, h1: count(html, /<h1[\s>]/g) }).toEqual({ url, h1: 1 });
      expect({ url, offset: /\boffset-\d/.test(html) }).toEqual({
        url,
        offset: false,
      });
    }
  });
});

describe("login and signup", () => {
  test("every field has a label, an id and an accessible message", async () => {
    const agent = createAgent();
    const login = (await agent.get("/login")).text;
    expect(login).toContain('<label for="username" class="form-label">Username');
    expect(login).toContain('id="username"');
    expect(login).toContain('autocomplete="username"');
    expect(login).toContain('aria-describedby="username-feedback"');
    expect(login).toContain('autocomplete="current-password"');
    expect(login).toContain('class="invalid-feedback"');
    expect(login).toContain('class="btn btn-dark"');

    const signup = (await agent.get("/signup")).text;
    expect(signup).toContain('aria-describedby="username-hint username-feedback"');
    expect(signup).toContain('aria-describedby="password-hint password-feedback"');
    expect(signup).toContain('autocomplete="new-password"');
    expect(signup).toContain('minlength="10"');
    expect(signup).toContain('type="email"');
  });

  test("the form column is full width on phones and centred from md", async () => {
    const html = (await createAgent().get("/login")).text;
    expect(html).toContain("col-12 col-md-8 col-lg-6 mx-auto");
  });
});

describe("error pages", () => {
  test("a 404 has an h1 naming the problem, a way back, and no alert role", async () => {
    const html = (await createAgent().get("/no-such-page")).text;
    expect(html).toMatch(/<h1 class="alert-heading h4" id="error-title">404/);
    expect(html).toContain('aria-labelledby="error-title"');
    expect(html).toContain('href="/listings"');
    expect(html).not.toContain('role="alert"');
  });
});

describe("listings page", () => {
  test("categories are links; the grid starts at one column", async () => {
    jest.spyOn(Listing, "find").mockResolvedValue([]);
    const html = (await createAgent().get("/listings")).text;
    expect(count(html, /<a class="filter" href="\/listings\?category=/g)).toBe(17);
    expect(html).toContain('<a class="filter" href="/listings?category=trending">');
    expect(html).toContain('<a class="filter" href="/listings?category=amazing-pools">');
    expect(html).toContain('<nav class="filter-nav" aria-label="Categories">');
    expect(html).toContain("row-cols-1 row-cols-md-2 row-cols-lg-3");
    expect(html).not.toContain('<div class="filter">');
    expect(html).toContain("Explore places to stay");
  });
});

describe("detail page", () => {
  test("two columns from lg, a summary aside, labelled sections", async () => {
    stubShow(plainListing());
    const html = (await createAgent().get(`/listings/${OID}`)).text;
    expect(html).toMatch(/<h1>Seaside Cottage<\/h1>/);
    expect(html).toContain("col-12 col-lg-7");
    expect(html).toContain("col-12 col-lg-5");
    expect(html).toContain("<aside");
    for (const id of ["about-heading", "summary-heading", "map-heading", "reviews-heading"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("No reviews yet.");
    expect(html).toMatch(/alt="Photo of Seaside Cottage"/);
  });

  test("a listing without a photo uses a decorative placeholder (empty alt)", async () => {
    stubShow(plainListing({ image: undefined }));
    const html = (await createAgent().get(`/listings/${OID}`)).text;
    expect(html).toMatch(/<img class="card-img-top show-img" src="https:\/\/[^"]+" alt="">/);
  });

  test("reviews are a list of articles with an accessible rating", async () => {
    stubShow(
      plainListing({
        reviews: [
          {
            _id: "507f1f77bcf86cd799439012",
            rating: 4,
            comment: "Lovely stay.",
            author: { username: "guest1" },
          },
          {
            _id: "507f1f77bcf86cd799439013",
            rating: 2,
            comment: "<b>x</b>",
            author: null,
          },
        ],
      }),
    );
    const html = (await createAgent().get(`/listings/${OID}`)).text;
    expect(count(html, /<article class="review-card">/g)).toBe(2);
    expect(html).toContain("@ guest1");
    expect(html).toContain("@ Unknown User");
    expect(html).toContain("Rated 4 out of 5");
    expect(html).toContain("Rated 2 out of 5");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("row-cols-1 row-cols-md-2");
  });

  test("a very long unbroken title is escaped and contained by the layout class", async () => {
    stubShow(plainListing({ title: "A".repeat(300) }));
    const html = (await createAgent().get(`/listings/${OID}`)).text;
    expect(html).toContain('class="listing-detail');
    expect(html).toContain("A".repeat(300));
  });
});

describe("new and edit forms", () => {
  test("new: responsive column, every control has an id its label points at", async () => {
    const html = await renderView("listings/new.ejs", { currentPath: "/listings/new" });
    expect(html).toContain("col-12 col-md-10 col-lg-8 mx-auto");
    expect(html).toMatch(/<h1 class="h3">Create New Listing<\/h1>/);
    for (const id of ["title", "description", "image", "price", "country", "location"]) {
      expect(html).toContain(`<label for="${id}"`);
      expect(html).toMatch(new RegExp(`<(?:input|textarea)[^>]* id="${id}"`));
      expect(html).toContain(`id="${id}-feedback"`);
    }
    expect(html).toContain('action="/listings?_csrf=tok123"');
    expect(html).toContain('name="listing[price]"');
    expect(html).toMatch(/id="price"[^>]*type="number"/);
    expect(html).toContain("col-12 col-md-4");
    expect(html).toContain("col-12 col-md-8");
  });

  test("edit: values filled in, labels linked, current photo has alt text", async () => {
    const html = await renderView("listings/edit.ejs", {
      currentPath: `/listings/${OID}/edit`,
      listing: plainListing({ title: 'Cabin "North"' }),
      priceRupees: 1800,
      originalImageUrl: "https://res.cloudinary.test/a.jpg",
    });
    expect(html).toMatch(/<h1 class="h3">Edit your Listing<\/h1>/);
    expect(html).toContain('value="Cabin &#34;North&#34;"');
    expect(html).toContain('value="1800"');
    expect(html).toContain(`action="/listings/${OID}?_method=PUT&_csrf=tok123"`);
    expect(html).toContain('alt="Current photo of this listing"');
    for (const id of ["title", "description", "image", "price", "country", "location"]) {
      expect(html).toContain(`<label for="${id}"`);
      expect(html).toMatch(new RegExp(`<(?:input|textarea)[^>]* id="${id}"`));
    }
  });

  test("edit without a stored image shows no 'current image' block", async () => {
    const html = await renderView("listings/edit.ejs", {
      currentPath: `/listings/${OID}/edit`,
      listing: plainListing(),
      originalImageUrl: undefined,
    });
    expect(html).not.toContain("Current listing image");
  });
});
