// P10-T02: named lists, moving, notes and saved searches through the real
// router, controller and EJS views (layout included), with the services stubbed
// (no database). The services are tested in tests/unit/wishlistLists.service.test.js
// and tests/unit/savedSearches.service.test.js. Who is signed in is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const service = require("../../src/services/wishlists");
const lists = require("../../src/services/wishlistLists");
const searches = require("../../src/services/savedSearches");
const { ConflictError, NotFoundError, ValidationError } = require("../../src/utils/errors");
const wishlistsRouter = require("../../src/routes/wishlists");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const member = {
  _id: new ObjectId(),
  username: "asha",
  role: "member",
  status: "active",
};

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  Object.assign(a.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    req.user = user;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = (type, message) => {
      if (message) flashes.push([type, message]);
      return [];
    };
    res.locals.success = [];
    res.locals.error = [];
    res.locals.currUser = user;
    res.locals.currentPath = req.path;
    res.locals.formatMoney = formatMoney;
    res.locals.can = (action, resource) => can(action, user, resource);
    res.locals.mapPublicToken = "";
    res.locals.csrfToken = "tok";
    res.locals.cspNonce = "n";
    next();
  });
  a.use("/", wishlistsRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const LIST_A = String(new ObjectId());
const LIST_B = String(new ObjectId());
const STAY = String(new ObjectId());
const allLists = [
  { id: LIST_A, name: "Saved", isDefault: true, count: 2 },
  { id: LIST_B, name: "Goa <i>trip</i>", isDefault: false, count: 1 },
];
const card = { id: STAY, title: "Sea house", imageUrl: null, location: "Goa", country: "India", priceMinor: 500000, currency: "INR" };
const stayItem = (extra = {}) => ({ id: STAY, available: true, title: "Sea house", note: "", card, ...extra });

function stubPage({ items = [stayItem()] } = {}) {
  jest.spyOn(service, "listsFor").mockResolvedValue(allLists);
  return jest.spyOn(service, "overview").mockResolvedValue({ items, availableCount: items.length, limit: 100 });
}

describe("GET /wishlists with lists", () => {
  test("the lists bar: All saved, every list with its count (escaped), and a New list form", async () => {
    stubPage();
    const res = await request(app(member)).get("/wishlists");
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-lists");
    expect(res.text).toContain("All saved");
    expect(res.text).toContain(`href="/wishlists?list=${LIST_B}"`);
    expect(res.text).toContain("Goa &lt;i&gt;trip&lt;/i&gt;");
    expect(res.text).not.toContain("<i>trip</i>");
    expect(res.text).toContain("data-create-list");
    expect(res.text).toContain('name="_csrf" value="tok"');
    // the page of every saved stay is read-only: no note or move forms, no rename or delete
    expect(res.text).not.toContain("data-item-tools");
    expect(res.text).not.toContain("data-list-tools");
  });

  test("one list: its name as the heading, rename, delete (not for the main list), a note box and a move form per stay", async () => {
    const spy = stubPage({ items: [stayItem({ note: "Quiet <b>street</b>" })] });
    const res = await request(app(member)).get(`/wishlists?list=${LIST_B}`);
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][2]).toEqual({ listId: LIST_B });
    expect(res.text).toContain("data-list-tools");
    expect(res.text).toContain(`action="/wishlists/${LIST_B}/rename"`);
    expect(res.text).toContain(`action="/wishlists/${LIST_B}/delete"`);
    expect(res.text).toContain("they move to your main list");
    expect(res.text).toContain(`action="/wishlists/${LIST_B}/items/${STAY}/note"`);
    expect(res.text).toContain(`action="/wishlists/${LIST_B}/items/${STAY}/move"`);
    expect(res.text).toContain(`<option value="${LIST_A}">Saved</option>`);
    expect(res.text).not.toContain(`<option value="${LIST_B}">`); // it cannot be moved to itself
    expect(res.text).toContain("Quiet &lt;b&gt;street&lt;/b&gt;");
    expect(res.text).not.toContain("Quiet <b>street</b>");
  });

  test("the main list cannot be deleted from the page", async () => {
    stubPage();
    const res = await request(app(member)).get(`/wishlists?list=${LIST_A}`);
    expect(res.text).toContain(`action="/wishlists/${LIST_A}/rename"`);
    expect(res.text).not.toContain(`action="/wishlists/${LIST_A}/delete"`);
  });

  test("an id that is not one of the member's lists, or not an id, shows every saved stay", async () => {
    const spy = stubPage();
    for (const bad of [String(new ObjectId()), "nope", "x[]=1"]) {
      await request(app(member)).get(`/wishlists?list=${encodeURIComponent(bad)}`);
    }
    for (const call of spy.mock.calls) expect(call[2]).toEqual({});
  });
});

describe("list actions", () => {
  const post = (url, body = {}, flashes = []) => request(app(member, flashes)).post(url).type("form").send(body);

  test("create: the service gets the member and the name; back to the new list with a message", async () => {
    const spy = jest.spyOn(lists, "createList").mockResolvedValue({ id: LIST_B, name: "Goa" });
    const flashes = [];
    const res = await post("/wishlists", { name: "Goa" }, flashes);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/wishlists?list=${LIST_B}`);
    expect(spy.mock.calls[0][0]).toBe(member._id);
    expect(spy.mock.calls[0][1]).toBe("Goa");
    expect(flashes[0]).toEqual(["success", 'List "Goa" created.']);
  });

  test("a refusal the member can fix (name in use, too many lists, bad name) is shown on the page, not as an error page", async () => {
    for (const err of [new ConflictError("You already have a list with that name.", { code: "name_taken" }), new ValidationError("Give the list a name.")]) {
      jest.spyOn(lists, "createList").mockRejectedValue(err);
      const flashes = [];
      const res = await post("/wishlists", { name: "" }, flashes);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/wishlists");
      expect(flashes[0]).toEqual(["error", err.message]);
      jest.restoreAllMocks();
    }
  });

  test("rename and delete go to the list's own id from the URL; the delete message says how many stays moved", async () => {
    const rename = jest.spyOn(lists, "renameList").mockResolvedValue({ id: LIST_B, name: "New" });
    let res = await post(`/wishlists/${LIST_B}/rename`, { name: "New" });
    expect(rename.mock.calls[0].slice(0, 3)).toEqual([member._id, LIST_B, "New"]);
    expect(res.headers.location).toBe(`/wishlists?list=${LIST_B}`);

    jest.spyOn(lists, "deleteList").mockResolvedValue({ moved: 2 });
    const flashes = [];
    res = await post(`/wishlists/${LIST_B}/delete`, {}, flashes);
    expect(res.headers.location).toBe("/wishlists");
    expect(flashes[0][1]).toMatch(/Its 2 stays were moved to your main list/);
  });

  test("a refused delete keeps the member on that list", async () => {
    jest.spyOn(lists, "deleteList").mockRejectedValue(new ConflictError("Your main list cannot be deleted.", { code: "default_list" }));
    const res = await post(`/wishlists/${LIST_A}/delete`);
    expect(res.headers.location).toBe(`/wishlists?list=${LIST_A}`);
  });

  test("move and note: ids come from the URL, the target and the text from the form, nothing else", async () => {
    const move = jest.spyOn(lists, "moveItem").mockResolvedValue({ moved: true });
    await post(`/wishlists/${LIST_A}/items/${STAY}/move`, { to: LIST_B, owner: "someone-else", from: "x" });
    expect(move.mock.calls[0][1]).toEqual({ from: LIST_A, to: LIST_B, listingId: STAY });
    const note = jest.spyOn(lists, "setNote").mockResolvedValue({ note: "n" });
    const flashes = [];
    const res = await post(`/wishlists/${LIST_A}/items/${STAY}/note`, { note: "n", owner: "x" }, flashes);
    expect(note.mock.calls[0][1]).toEqual({ listId: LIST_A, listingId: STAY, note: "n" });
    expect(res.headers.location).toBe(`/wishlists?list=${LIST_A}`);
    expect(flashes[0]).toEqual(["success", "Note saved."]);
  });

  test("someone else's list or stay is the same 404 as a missing one", async () => {
    jest.spyOn(lists, "moveItem").mockRejectedValue(new NotFoundError("That list does not exist."));
    const res = await post(`/wishlists/${LIST_A}/items/${STAY}/move`, { to: LIST_B });
    expect(res.status).toBe(404);
  });

  test("signed out: every list route sends the visitor to log in and calls nothing", async () => {
    const spy = jest.spyOn(lists, "createList");
    for (const [method, url] of [["post", "/wishlists"], ["post", `/wishlists/${LIST_A}/rename`], ["post", `/wishlists/${LIST_A}/delete`], ["post", `/wishlists/${LIST_A}/items/${STAY}/move`], ["post", `/wishlists/${LIST_A}/items/${STAY}/note`], ["get", "/saved-searches"], ["post", "/saved-searches"], ["post", `/saved-searches/${LIST_A}/delete`]]) {
      const res = await request(app(undefined))[method](url).type("form").send({});
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toMatch(/\/login/);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("saved searches", () => {
  test("the page lists them with a re-run link, escaped, and a delete form", async () => {
    jest.spyOn(searches, "list").mockResolvedValue([
      { id: LIST_A, name: "Goa <b>Dec</b>", summary: "Goa · 2 guests", href: "/listings?dest=Goa&guests=2", createdAt: new Date() },
    ]);
    const res = await request(app(member)).get("/saved-searches");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toContain("data-saved-searches");
    expect(res.text).toContain('href="/listings?dest=Goa&amp;guests=2"');
    expect(res.text).toContain("Goa &lt;b&gt;Dec&lt;/b&gt;");
    expect(res.text).not.toContain("Goa <b>Dec</b>");
    expect(res.text).toContain(`action="/saved-searches/${LIST_A}/delete"`);
  });

  test("none yet: a friendly message", async () => {
    jest.spyOn(searches, "list").mockResolvedValue([]);
    const res = await request(app(member)).get("/saved-searches");
    expect(res.text).toContain("No saved searches yet");
  });

  test("saving: the whole form goes to the service (it builds the query), then to the page of saved searches", async () => {
    const spy = jest.spyOn(searches, "save").mockResolvedValue({ id: LIST_A });
    const flashes = [];
    const res = await request(app(member, flashes)).post("/saved-searches").type("form").send({ name: "Goa", dest: "Goa", guests: "2" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/saved-searches");
    expect(spy.mock.calls[0][0]).toBe(member._id);
    expect(spy.mock.calls[0][1].name).toBe("Goa");
    expect(spy.mock.calls[0][1].params).toEqual({ name: "Goa", dest: "Goa", guests: "2" });
    expect(flashes[0][0]).toBe("success");
  });

  test("a refused save (empty search, name in use) goes back to the page it came from with the message", async () => {
    jest.spyOn(searches, "save").mockRejectedValue(new ConflictError("You already have a saved search with that name.", { code: "name_taken" }));
    const flashes = [];
    const res = await request(app(member, flashes))
      .post("/saved-searches")
      .set("Host", "dimora.test")
      .set("Referer", "http://dimora.test/listings?dest=Goa")
      .type("form")
      .send({ name: "A", dest: "Goa" });
    expect(res.headers.location).toBe("/listings?dest=Goa");
    expect(flashes[0]).toEqual(["error", "You already have a saved search with that name."]);
  });

  test("delete: own only (the service answers 404 otherwise)", async () => {
    const spy = jest.spyOn(searches, "remove").mockResolvedValue({ removed: true });
    const res = await request(app(member)).post(`/saved-searches/${LIST_A}/delete`).type("form").send({});
    expect(res.headers.location).toBe("/saved-searches");
    expect(spy.mock.calls[0].slice(0, 2)).toEqual([member._id, LIST_A]);
    jest.spyOn(searches, "remove").mockRejectedValue(new NotFoundError("That saved search does not exist."));
    expect((await request(app(member)).post(`/saved-searches/${LIST_B}/delete`).type("form").send({})).status).toBe(404);
  });
});
