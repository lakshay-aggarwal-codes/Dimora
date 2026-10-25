// Small helpers for the journeys (P17-T03).
const { expect } = require("@playwright/test");
const { USERS } = require("./data");

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT || 3101}`;
const DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD, `n` days from now (UTC date; the journeys use dates >= 10 days away). */
function inDays(n) {
  return new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
}

/** Signs in through the login form. */
async function login(page, who) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(who.username);
  await page.getByLabel(/password/i).fill(USERS.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Opens a listing from the search results by its title and returns its id. */
async function openListingFromSearch(page, destination, title) {
  await page.goto(`/listings?destination=${encodeURIComponent(destination)}`);
  await page.getByRole("link", { name: new RegExp(title) }).first().click();
  await expect(page).toHaveURL(/\/listings\/[0-9a-f]{24}/);
  return page.url().match(/\/listings\/([0-9a-f]{24})/)[1];
}

/**
 * On a listing page: chooses the dates (through the page's own `?in=&out=`
 * link, which the date picker reads), waits for the live price and presses
 * Reserve. Ends on the checkout page.
 */
async function reserve(page, listingId, checkIn, checkOut) {
  await page.goto(`/listings/${listingId}?in=${checkIn}&out=${checkOut}`);
  const button = page.locator("[data-reserve]");
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page).toHaveURL(/\/checkout/);
}

/** The id in /trips/<id>. */
function tripId(page) {
  return page.url().match(/\/trips\/([0-9a-f]{24})/)[1];
}

/** Test-only: moves the booking into the past and lets the sweeper complete it. */
async function completeStay(request, reservationId) {
  const res = await request.post(`${CONTROL}/complete-stay?id=${reservationId}`);
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  expect(body.errors || []).toEqual([]);
  expect(body.completed).toBeGreaterThanOrEqual(1);
}

module.exports = { inDays, login, openListingFromSearch, reserve, tripId, completeStay };
