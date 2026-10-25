// Browser tests of the critical journeys (P17-T03). They run one after the
// other against the server in e2e/server.js; each booking uses its own dates
// so the journeys never fight over the same nights.
const { test, expect } = require("@playwright/test");
const { USERS } = require("./data");
const { inDays, login, openListingFromSearch, reserve, tripId, completeStay } = require("./helpers");

const GUEST = USERS.guest;
const HOST = USERS.host;

test.describe("guest journeys", () => {
  test("search, book instantly, see the trip", async ({ page }) => {
    await login(page, GUEST);
    const id = await openListingFromSearch(page, "Panaji", "E2E Instant Villa");
    await reserve(page, id, inDays(10), inDays(13));
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page).toHaveURL(/\/trips\/[0-9a-f]{24}/);
    await expect(page.getByRole("heading", { name: /E2E Instant Villa/ })).toBeVisible();
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();

    // And it is listed under the guest's trips.
    await page.goto("/trips");
    await expect(page.getByText(/E2E Instant Villa/).first()).toBeVisible();
  });

  test("request a stay, the host accepts, the guest sees it confirmed", async ({ page, browser }) => {
    await login(page, GUEST);
    const id = await openListingFromSearch(page, "Panaji", "E2E Request Cottage");
    await reserve(page, id, inDays(20), inDays(23));
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page).toHaveURL(/\/trips\/[0-9a-f]{24}/);
    const trip = tripId(page);
    await expect(page.getByText(/waiting|pending|request/i).first()).toBeVisible();

    // The host, in their own browser session, answers.
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await login(hostPage, HOST);
    await hostPage.goto("/host/reservations");
    await expect(hostPage.getByText(/E2E Request Cottage/).first()).toBeVisible();
    await hostPage.locator(`form[action="/host/reservations/${trip}/accept"] [data-accept]`).click();
    await expect(hostPage.getByText(/confirmed stays/i)).toBeVisible();
    await hostContext.close();

    // The guest sees the answer.
    await page.goto(`/trips/${trip}`);
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();
  });

  test("review a stay after it is over", async ({ page, request }) => {
    await login(page, GUEST);
    const id = await openListingFromSearch(page, "Panaji", "E2E Instant Villa");
    await reserve(page, id, inDays(30), inDays(33));
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page).toHaveURL(/\/trips\/[0-9a-f]{24}/);
    const trip = tripId(page);

    // Before the stay there is nothing to review yet.
    await expect(page.locator("#review")).toHaveCount(0);

    // Time is moved by the test server: the stay is put in the past and the sweeper completes it.
    await completeStay(request, trip);

    await page.goto(`/trips/${trip}`);
    await expect(page.locator("#review")).toBeVisible();
    await page.getByLabel("5 stars").check({ force: true });
    await page.getByLabel("Comment").fill("Lovely villa, easy check-in.");
    await page.getByRole("button", { name: "Submit review" }).click();

    // The review shows on the trip and on the public listing page.
    await page.goto(`/trips/${trip}`);
    await expect(page.getByText("Lovely villa, easy check-in.")).toBeVisible();
    await page.goto(`/listings/${id}`);
    await expect(page.getByText("Lovely villa, easy check-in.")).toBeVisible();
  });

  // KNOWN GAP (see docs/tasks/P17-T03.md): in the repository this was written
  // against, `src/controllers/trips.js` has no `cancel` handler (the route in
  // src/routes/trips.js points at nothing) and neither the trip page nor the
  // host inbox has a cancel control, although P09-T03 is marked done. A browser
  // journey cannot cancel anything until that is restored. Remove `fixme` then.
  test.fixme("cancel a booking and see the refund", async ({ page }) => {
    await login(page, GUEST);
    await page.goto("/trips");
  });
});

test.describe("host journeys", () => {
  test("create a listing with the wizard, publish it, find it in search", async ({ page }) => {
    await login(page, HOST);
    await page.goto("/host/listings/new");

    const photo = {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    };
    const textFields = {
      title: "E2E Wizard Home",
      description:
        "A sunny two-bedroom home a short walk from the sea, with a fast connection, a shaded balcony and a fully equipped kitchen for longer stays.",
      line1: "12 Beach Road",
      city: "Panaji",
      state: "Goa",
      country: "India",
      postalCode: "403001",
      guests: "4",
      bedrooms: "2",
      beds: "2",
      bathrooms: "1",
      price: "3500",
      cleaningFee: "500",
      minNights: "1",
      maxNights: "14",
      houseRules: "No parties. Quiet after 10 pm.",
    };

    // Fills whatever fields the current step has (only the empty ones), then moves on.
    async function fillStep() {
      for (const [id, value] of Object.entries(textFields)) {
        const field = page.locator(`#${id}`);
        if ((await field.count()) && (await field.inputValue()) === "") await field.fill(value);
      }
      for (const id of ["propertyType", "roomType", "cancellationPolicy"]) {
        const select = page.locator(`select#${id}`);
        if ((await select.count()) && (await select.inputValue()) === "") await select.selectOption({ index: 1 });
      }
    }

    let published = false;
    for (let i = 0; i < 12 && !published; i += 1) {
      const heading = (await page.locator("h1").first().innerText()).trim();
      const step = Number((heading.match(/Step (\d+) of/) || [])[1] || 0);
      if (step === 4) {
        // Photos: upload one, then continue.
        await page.locator("#photos-input").setInputFiles(photo);
        await page.getByRole("button", { name: "Upload" }).click();
        await page.waitForLoadState("load");
        await page.getByRole("button", { name: "Continue" }).click();
      } else if (step === 6) {
        await page.getByRole("button", { name: "Publish listing" }).click();
        published = true;
      } else {
        await fillStep();
        await page.getByRole("button", { name: /Save and continue/ }).click();
      }
      await page.waitForLoadState("load");
    }
    expect(published, "the wizard reached the review step and published").toBe(true);

    // The published listing is public: it opens as a guest page and is found by search.
    await expect(page).toHaveURL(/\/listings\/[0-9a-f]{24}/);
    await expect(page.getByRole("heading", { name: /E2E Wizard Home/ })).toBeVisible();
    await page.goto(`/listings?destination=${encodeURIComponent("Panaji")}`);
    await expect(page.getByRole("link", { name: /E2E Wizard Home/ }).first()).toBeVisible();
  });
});
