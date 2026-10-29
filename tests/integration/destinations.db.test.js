// P05-T06 against a real MongoDB and the real app. Needs a MongoDB; skipped
// with SKIP_DB_TESTS=1.
const assert = require("node:assert/strict");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

async function place(listing, { city, state, country, status = "published", deletedAt = null }) {
  await Listing.updateOne(
    { _id: listing._id },
    {
      $set: {
        status,
        deletedAt,
        "address.city": city,
        "address.state": state,
        "address.country": country,
        cityKey: city.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
        stateKey: state.toLowerCase(),
        countryKey: country.toLowerCase(),
      },
    },
  );
}

describeDb("destination suggestions (database)", () => {
  useTestDb();

  test("suggests public places with counts, most stays first, and never a draft, unpublished or deleted stay", async () => {
    const { user } = await createUser();
    const a = await createListing({ owner: user });
    const b = await createListing({ owner: user });
    const c = await createListing({ owner: user });
    const d = await createListing({ owner: user });
    const e = await createListing({ owner: user });
    await place(a, { city: "Panaji", state: "Goa", country: "India" });
    await place(b, { city: "Panaji", state: "Goa", country: "India" });
    await place(c, { city: "Panipat", state: "Haryana", country: "India" });
    await place(d, { city: "Panama City", state: "Panama", country: "Panama", status: "draft" });
    await place(e, { city: "Panchgani", state: "Maharashtra", country: "India", deletedAt: new Date() });

    const res = await createAgent().get("/api/destinations?q=pan");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /json/);
    assert.deepEqual(
      res.body.suggestions.map((s) => [s.dest, s.count]),
      [["Panaji, Goa, India", 2], ["Panipat, Haryana, India", 1]],
    );
    assert.equal(JSON.stringify(res.body).includes("Panchgani"), false);
    assert.equal(JSON.stringify(res.body).includes("Panama City"), false);
  });

  test("a suggestion leads to a search that finds that stay", async () => {
    const { user } = await createUser();
    const a = await createListing({ owner: user });
    await place(a, { city: "Panaji", state: "Goa", country: "India" });
    const { body } = await createAgent().get("/api/destinations?q=panaji");
    const page = await createAgent().get(`/listings?dest=${encodeURIComponent(body.suggestions[0].dest)}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(a.title || String(a._id)));
  });

  test("short, missing, repeated and odd q give an empty list and 200", async () => {
    const agent = createAgent();
    for (const url of ["/api/destinations", "/api/destinations?q=", "/api/destinations?q=p", "/api/destinations?q=a&q=b", "/api/destinations?q[a]=1", "/api/destinations?q[$ne]=x"]) {
      const res = await agent.get(url);
      assert.ok([200, 400].includes(res.status), `${url} -> ${res.status}`);
      if (res.status === 200) assert.deepEqual(res.body, { suggestions: [] });
    }
  });

  test("regex characters in q are plain text", async () => {
    const res = await createAgent().get(`/api/destinations?q=${encodeURIComponent(".*")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.suggestions, []);
  });

  test("the pages that have a search box load the script and mark the box", async () => {
    const home = await createAgent().get("/listings");
    assert.match(home.text, /\/js\/destination-autocomplete\.js/);
    assert.match(home.text, /data-destination-autocomplete/);
  });
});
