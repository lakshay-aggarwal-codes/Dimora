// P11-T01: src/services/notifications.js against an in-memory model (no
// database). The database-backed checks are in
// tests/integration/notifications.db.test.js.
const { fakeNotificationModel } = require("../helpers/fakeNotificationModel");
const service = require("../../src/services/notifications");
const { ValidationError, NotFoundError } = require("../../src/utils/errors");
const {
  READ_RETENTION_DAYS,
  PAGE_SIZE,
} = require("../../src/config/notifications");

const ANN = "aaaaaaaaaaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbbbbbbbbbb";
const RES = "cccccccccccccccccccccccc";
const DAY = 24 * 60 * 60 * 1000;

let Model;
let opts;
beforeEach(() => {
  Model = fakeNotificationModel();
  opts = { NotificationModel: Model, now: new Date("2026-10-24T12:00:00Z") };
});

const send = (user = ANN, over = {}) =>
  service.notify(
    user,
    "reservation.requested",
    { kind: "reservation", id: RES },
    { title: "New booking request", body: "Ravi asked to stay.", url: `/trips/${RES}`, ...over },
    opts,
  );

describe("notify", () => {
  test("writes one row, for the recipient only", async () => {
    const row = await send(ANN);
    expect(Model.rows).toHaveLength(1);
    expect(row.user).toBe(ANN);
    expect(row.type).toBe("reservation.requested");
    expect(row.ref).toEqual({ kind: "reservation", id: RES });
    expect(row.title).toBe("New booking request");
    expect(row.body).toBe("Ravi asked to stay.");
    expect(row.url).toBe(`/trips/${RES}`);
    expect(row.readAt).toBeNull();
    // Nobody else got anything.
    expect(await service.countUnread(BEN, opts)).toBe(0);
    expect(await service.countUnread(ANN, opts)).toBe(1);
  });

  test("accepts a user document, an object id and upper-case hex", async () => {
    await send({ _id: ANN, username: "ann" });
    await send({ _id: { toString: () => BEN } });
    await send(ANN.toUpperCase());
    expect(Model.rows.map((r) => r.user)).toEqual([ANN, BEN, ANN]);
  });

  test("trims the text, keeps only title, text and link, and drops other keys", async () => {
    const row = await service.notify(
      ANN,
      "listing.moderated",
      undefined,
      {
        title: "  Your listing was suspended  ",
        body: "   ",
        url: undefined,
        html: "<script>alert(1)</script>",
        user: BEN,
      },
      opts,
    );
    expect(row.title).toBe("Your listing was suspended");
    expect(row).not.toHaveProperty("body");
    expect(row).not.toHaveProperty("url");
    expect(row).not.toHaveProperty("html");
    expect(row.user).toBe(ANN); // a `user` key in the payload cannot redirect it
    expect(row).not.toHaveProperty("ref");
  });

  test("text is stored as given (escaped by the views, not here)", async () => {
    const row = await send(ANN, { title: "<b>Hi</b> & bye" });
    expect(row.title).toBe("<b>Hi</b> & bye");
  });

  test("limits: a title of 120 characters is fine, 121 is refused", async () => {
    await expect(send(ANN, { title: "x".repeat(120) })).resolves.toBeTruthy();
    await expect(send(ANN, { title: "x".repeat(121) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(send(ANN, { body: "y".repeat(300) })).resolves.toBeTruthy();
    await expect(send(ANN, { body: "y".repeat(301) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test.each([
    ["no recipient", undefined],
    ["null recipient", null],
    ["a short id", "abc"],
    ["a non-hex id", "z".repeat(24)],
    ["an object without an id", {}],
    ["an array", [ANN]],
  ])("refuses %s and writes nothing", async (_name, user) => {
    await expect(
      service.notify(user, "a.b", null, { title: "t" }, opts),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(Model.rows).toHaveLength(0);
  });

  test.each([
    ["no type", undefined],
    ["a number", 5],
    ["no dot", "requested"],
    ["upper case", "Reservation.Requested"],
    ["a space", "reservation requested"],
    ["too long", `a.${"b".repeat(60)}`],
  ])("refuses a type with %s", async (_name, type) => {
    await expect(
      service.notify(ANN, type, null, { title: "t" }, opts),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(Model.rows).toHaveLength(0);
  });

  test.each([
    ["no payload", undefined],
    ["a string payload", "hello"],
    ["no title", {}],
    ["a blank title", { title: "   " }],
    ["a title that is not text", { title: 42 }],
    ["a title that is an object", { title: { $ne: "" } }],
    ["a control character in the title", { title: "a\u0000b" }],
    ["a body that is not text", { title: "t", body: ["x"] }],
  ])("refuses %s", async (_name, payload) => {
    await expect(
      service.notify(ANN, "a.b", null, payload, opts),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(Model.rows).toHaveLength(0);
  });

  test.each([
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example",
    "javascript:alert(1)",
    "trips/1",
    "/login",
    "/signup",
    "/a\nb",
  ])("refuses the link %j (same-site pages only)", async (url) => {
    await expect(send(ANN, { url })).rejects.toBeInstanceOf(ValidationError);
    expect(Model.rows).toHaveLength(0);
  });

  test("a same-site link with a query string is kept", async () => {
    const row = await send(ANN, { url: "/trips?tab=pending" });
    expect(row.url).toBe("/trips?tab=pending");
  });

  test.each([
    ["an unknown kind", { kind: "user-secret", id: RES }],
    ["no id", { kind: "reservation" }],
    ["a bad id", { kind: "reservation", id: "nope" }],
    ["a string", "reservation"],
    ["an array", [{ kind: "reservation", id: RES }]],
  ])("refuses a reference with %s", async (_name, ref) => {
    await expect(
      service.notify(ANN, "a.b", ref, { title: "t" }, opts),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(Model.rows).toHaveLength(0);
  });

  test("a reference is optional", async () => {
    const row = await service.notify(ANN, "a.b", null, { title: "t" }, opts);
    expect(row).not.toHaveProperty("ref");
  });
});

describe("countUnread", () => {
  test("counts only that member's unread rows", async () => {
    await send(ANN);
    await send(ANN);
    await send(BEN);
    await service.markRead(ANN, Model.rows[0]._id, opts);
    expect(await service.countUnread(ANN, opts)).toBe(1);
    expect(await service.countUnread(BEN, opts)).toBe(1);
  });

  test("refuses an invalid member id", async () => {
    await expect(service.countUnread("x", opts)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("listFor", () => {
  async function fill(n, user = ANN) {
    for (let i = 1; i <= n; i += 1) await send(user, { title: `Message ${i}` });
  }

  test("newest first, only the member's own", async () => {
    await fill(3, ANN);
    await send(BEN, { title: "Ben only" });
    const list = await service.listFor(ANN, {}, opts);
    expect(list.items.map((i) => i.title)).toEqual([
      "Message 3",
      "Message 2",
      "Message 1",
    ]);
    expect(list.total).toBe(3);
    expect(list.unread).toBe(3);
    expect(list.show).toBe("all");
    const bens = await service.listFor(BEN, {}, opts);
    expect(bens.items.map((i) => i.title)).toEqual(["Ben only"]);
  });

  test("pages of PAGE_SIZE; a page past the end shows the last one", async () => {
    await fill(PAGE_SIZE * 2 + 5);
    const first = await service.listFor(ANN, {}, opts);
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.totalPages).toBe(3);
    const third = await service.listFor(ANN, { page: "3" }, opts);
    expect(third.items).toHaveLength(5);
    const far = await service.listFor(ANN, { page: "99" }, opts);
    expect(far.page).toBe(3);
    const junk = await service.listFor(ANN, { page: "-1; drop" }, opts);
    expect(junk.page).toBe(1);
  });

  test("show=unread lists only unread rows and counts them", async () => {
    await fill(3);
    await service.markRead(ANN, Model.rows[0]._id, opts);
    const list = await service.listFor(ANN, { show: "unread" }, opts);
    expect(list.items.map((i) => i.title)).toEqual(["Message 3", "Message 2"]);
    expect(list.show).toBe("unread");
    expect(list.unread).toBe(2);
    expect(list.total).toBe(2);
    // Anything else means "all".
    const all = await service.listFor(ANN, { show: "{$ne:1}" }, opts);
    expect(all.show).toBe("all");
    expect(all.items).toHaveLength(3);
  });

  test("an empty inbox is one empty page", async () => {
    const list = await service.listFor(ANN, {}, opts);
    expect(list).toMatchObject({ items: [], page: 1, totalPages: 1, total: 0, unread: 0 });
  });

  test("each item says whether it is read, and carries a safe link and a date", async () => {
    await send(ANN, { url: "/trips" });
    Model.rows[0].url = "https://evil.example/"; // tampered in the database
    const [item] = (await service.listFor(ANN, {}, opts)).items;
    expect(item).toMatchObject({
      id: Model.rows[0]._id,
      type: "reservation.requested",
      read: false,
      url: null,
    });
    expect(item.when).toMatch(/Oct/);
    expect(item.iso).toBe(Model.rows[0].createdAt.toISOString());
  });
});

describe("markRead", () => {
  test("marks one read and sets the delete date", async () => {
    await send(ANN);
    const id = Model.rows[0]._id;
    expect(await service.markRead(ANN, id, opts)).toEqual({ changed: true });
    expect(Model.rows[0].readAt).toEqual(opts.now);
    expect(Model.rows[0].deleteAfter).toEqual(
      new Date(opts.now.getTime() + READ_RETENTION_DAYS * DAY),
    );
  });

  test("marking again is fine and changes nothing", async () => {
    await send(ANN);
    const id = Model.rows[0]._id;
    await service.markRead(ANN, id, opts);
    const first = Model.rows[0].deleteAfter;
    const later = { ...opts, now: new Date("2026-11-30T00:00:00Z") };
    expect(await service.markRead(ANN, id, later)).toEqual({ changed: false });
    expect(Model.rows[0].deleteAfter).toEqual(first);
  });

  test("someone else's notification is a 404 and stays unread", async () => {
    await send(BEN);
    const id = Model.rows[0]._id;
    await expect(service.markRead(ANN, id, opts)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(Model.rows[0].readAt).toBeNull();
  });

  test.each(["", "abc", "{$ne:1}", undefined, null, {}, ["a"]])(
    "a malformed id (%j) is the same 404",
    async (id) => {
      await expect(service.markRead(ANN, id, opts)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    },
  );

  test("an id that does not exist is the same 404", async () => {
    await expect(
      service.markRead(ANN, "f".repeat(24), opts),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("markAllRead", () => {
  test("marks only that member's unread rows", async () => {
    await send(ANN);
    await send(ANN);
    await send(BEN);
    await service.markRead(ANN, Model.rows[0]._id, opts);
    expect(await service.markAllRead(ANN, opts)).toEqual({ updated: 1 });
    expect(await service.countUnread(ANN, opts)).toBe(0);
    expect(await service.countUnread(BEN, opts)).toBe(1);
    expect(await service.markAllRead(ANN, opts)).toEqual({ updated: 0 });
  });

  test("every row marked gets a delete date", async () => {
    await send(ANN);
    await send(ANN);
    await service.markAllRead(ANN, opts);
    for (const row of Model.rows) {
      expect(row.deleteAfter).toEqual(
        new Date(opts.now.getTime() + READ_RETENTION_DAYS * DAY),
      );
    }
  });
});

test("every query the service sends names a member", async () => {
  await send(ANN);
  await send(BEN);
  await service.countUnread(ANN, opts);
  await service.listFor(ANN, { show: "unread", page: "2" }, opts);
  await service.markRead(ANN, Model.rows[0]._id, opts);
  await service
    .markRead(ANN, Model.rows[1]._id, opts)
    .catch(() => undefined);
  await service.markAllRead(ANN, opts);
  expect(Model.filters.length).toBeGreaterThan(5);
  for (const filter of Model.filters) {
    expect(filter.user).toBe(ANN);
  }
});
