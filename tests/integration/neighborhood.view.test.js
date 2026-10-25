// P15-T02: the "What's around" block. Names come from OpenStreetMap (strangers):
// they must come out escaped. Rendering never touches the network.
const path = require("node:path");
const ejs = require("ejs");
const { neighborhoodFor } = require("../../src/services/neighborhood");

const PARTIAL = path.join(__dirname, "..", "..", "views", "partials", "neighborhood.ejs");
const view = () =>
  neighborhoodFor({
    nearby: {
      fetchedAt: new Date("2026-10-25T06:00:00Z"),
      source: "OpenStreetMap contributors",
      items: [
        { category: "food", name: '<img src=x onerror="alert(1)">', kind: "cafe", distanceM: 640 },
        { category: "food", name: null, kind: "fast_food", distanceM: 300 },
        { category: "transit", name: "Panaji Bus Stand", kind: "bus_stop", distanceM: 1240 },
      ],
    },
  });

describe("neighborhood partial", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test("escapes names; shows distances, attribution, the incomplete-data note and the date", async () => {
    global.fetch = jest.fn();
    const html = await ejs.renderFile(PARTIAL, { neighborhood: view() });
    expect(html).toContain("&lt;img src=x onerror=&#34;alert(1)&#34;&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("\u2248 650 m straight-line");
    expect(html).toContain("\u2248 300 m straight-line");
    expect(html).toContain("fast food");
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).toContain("may be incomplete");
    expect(html).toContain("not walking or driving routes");
    expect(html).toContain("Updated 2026-10-25");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("works without JavaScript: every list is in the page, the tab strip is hidden until the script runs", async () => {
    const html = await ejs.renderFile(PARTIAL, { neighborhood: view() });
    expect(html).toContain('data-panel="food"');
    expect(html).toContain('data-panel="transit"');
    expect(html).not.toContain('data-panel="park"'); // empty categories get no tab and no list
    expect(html).toMatch(/data-tablist hidden/);
    expect(html).toMatch(/data-ring-control hidden/);
  });

  test("tabs are labelled buttons; the map data holds radii only", async () => {
    const html = await ejs.renderFile(PARTIAL, { neighborhood: view() });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-controls="nb-panel-food"');
    const raw = /data-rings="([^"]*)"/.exec(html)[1].replace(/&#34;/g, '"');
    const rings = JSON.parse(raw);
    expect(rings).toEqual([
      { id: "food", label: "Food and drink", radiusM: 300 },
      { id: "transit", label: "Public transport", radiusM: 1250 },
    ]);
  });
});
