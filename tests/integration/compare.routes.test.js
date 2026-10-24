// P10-T03: GET /compare through the real router, controller and EJS views
// (layout included), with the compare service stubbed where a page needs data
// (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const service = require("../../src/services/compare");
const compareRouter = require("../../src/routes/compare");
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

function app(user) {
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
    req.flash = () => [];
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
  a.use("/", compareRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}


const idA = String(new ObjectId());
const idB = String(new ObjectId());
const idC = String(new ObjectId());

const live = (id, title, extra = {}) => ({
  id,
  available: true,
  title,
  href: `/listings/${id}`,
  imageUrl: null,
  where: "Goa, India",
  currency: "INR",
  nightlyMinor: 500000,
  capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
  amenities: ["wifi"],
  houseRules: "No parties",
  cancellation: { label: "Flexible", terms: "Free cancellation until 24 hours before check-in." },
  rating: { average: 4.5, count: 10 },
  quote: { state: "none" },
  ...extra,
});

function result(extra = {}) {
  const columns = [
    live(idA, "Sea <b>house</b>", { amenities: ["wifi", "pool"] }),
    live(idB, "Hill cabin"),
    { id: idC, available: false, amenities: [] },
  ];
  return {
    ids: [idA, idB, idC],
    dates: null,
    columns,
    removable: true,
    removeHref: {
      [idA]: `/compare?ids=${idB},${idC}`,
      [idB]: `/compare?ids=${idA},${idC}`,
      [idC]: `/compare?ids=${idA},${idB}`,
    },
    place: null,
    amenities: [
      { value: "wifi", label: "Wi-Fi", has: [true, true, false], onlyId: null, inAll: true },
      { value: "pool", label: "Pool", has: [true, false, false], onlyId: idA, inAll: false },
    ],
    cheapestId: null,
    blocked: null,
    ...extra,
  };
}

describe("GET /compare input", () => {
  test("5 ids is a 400", async () => {
    const five = Array.from({ length: 5 }, () => String(new ObjectId())).join(",");
    const res = await request(app(undefined)).get(`/compare?ids=${five}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("up to 4");
  });

  test("one id is a 400 with a plain message", async () => {
    const res = await request(app(undefined)).get(`/compare?ids=${idA}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Choose 2 to 4");
  });
});

describe("GET /compare page", () => {
  test("anyone can open it; names are escaped; unavailable column has no title", async () => {
    jest.spyOn(service, "compare").mockResolvedValue(result());
    const res = await request(app(undefined)).get(`/compare?ids=${idA},${idB},${idC}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("<b>house</b>");
    expect(res.text).toContain("No longer available");
    expect(res.text).toContain("Only in this one");
    expect(res.text).toContain(`href="/listings/${idA}"`);
    expect(res.text).toContain("Add check-in and check-out dates");
  });

  test("with dates: total, lowest-total badge and the place row with its caveat", async () => {
    const cols = result().columns;
    cols[0].quote = { state: "total", totalMinor: 1800000, avgPerNightMinor: 600000, nights: 3, feesPercent: "12.5%", taxIncluded: false, currency: "INR" };
    cols[1].quote = { state: "unavailable", note: "These nights are not available: 2026-12-02." };
    cols[0].distance = "about 1.4 km";
    cols[1].distance = "about 3.0 km";
    jest.spyOn(service, "compare").mockResolvedValue(
      result({
        dates: { in: "2026-12-01", out: "2026-12-04", guests: 2 },
        columns: cols,
        cheapestId: idA,
        place: { text: "station", name: "Panaji Station", note: "" },
      }),
    );
    const res = await request(app(undefined)).get(`/compare?ids=${idA},${idB},${idC}&in=2026-12-01&out=2026-12-04`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("₹18,000");
    expect(res.text).toContain("Lowest total");
    expect(res.text).toContain("12.5%");
    expect(res.text).toContain("Not bookable: These nights are not available");
    expect(res.text).toContain("about 1.4 km");
    expect(res.text).toContain("not a route");
  });

  test("mixed currencies: message instead of a table", async () => {
    jest.spyOn(service, "compare").mockResolvedValue(
      result({ blocked: "These stays are priced in different currencies, and comparing them is not supported yet." }),
    );
    const res = await request(app(undefined)).get(`/compare?ids=${idA},${idB}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("different currencies");
    expect(res.text).not.toContain("compare-table");
  });
});
