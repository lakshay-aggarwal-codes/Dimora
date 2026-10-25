// P15-T01: the host's "Nearby places" block. Names come from OpenStreetMap
// (strangers), so they must come out escaped. Rendering a page never fetches.
const path = require("node:path");
const ejs = require("ejs");

const PARTIAL = path.join(__dirname, "..", "..", "views", "partials", "nearby-status.ejs");
const render = (nearby) =>
  ejs.renderFile(PARTIAL, { listingId: "6720a0000000000000000001", nearby, csrfToken: "tok" });

const summary = (extra = {}) => ({
  enabled: true,
  fetchedOn: "2026-10-25",
  source: "OpenStreetMap contributors",
  failing: false,
  total: 2,
  categories: [
    {
      id: "food",
      label: "Food and drink",
      items: [
        { name: "<img src=x onerror=alert(1)>", kind: "cafe", distanceM: 120 },
        { name: null, kind: "fast_food", distanceM: 300 },
      ],
    },
    { id: "park", label: "Parks", items: [] },
  ],
  canRefresh: true,
  retryOn: null,
  refuseReason: null,
  ...extra,
});

describe("nearby-status partial", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test("escapes place names, labels the distances, never calls the network", async () => {
    global.fetch = jest.fn();
    const html = await render(summary());
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("fast food"); // unnamed place: its kind, as words
    expect(html).toContain("about 120 m");
    expect(html).toContain("not routes");
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).toContain("Nothing found nearby");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("the refresh button is a CSRF-protected POST, disabled with the date while cooling down", async () => {
    const open = await render(summary());
    expect(open).toContain('action="/host/listings/6720a0000000000000000001/nearby/refresh"');
    expect(open).toContain('value="tok"');
    expect(open).not.toContain("disabled");

    const waiting = await render(summary({ canRefresh: false, retryOn: "2026-10-26", refuseReason: "cooldown" }));
    expect(waiting).toContain("disabled");
    expect(waiting).toContain("Available again on 2026-10-26");
  });

  test("switched off, not fetched yet, and a failing fetch each say so", async () => {
    expect(await render(summary({ enabled: false }))).toContain("switched off");
    expect(await render(summary({ fetchedOn: null, total: 0 }))).toContain("Not fetched yet");
    expect(await render(summary({ failing: true }))).toContain("will try again automatically");
  });
});
