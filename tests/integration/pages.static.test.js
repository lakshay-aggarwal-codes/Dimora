// P01-T07 (D-08): home redirect, footer placeholders, navbar when logged out.
// Real app and views, no database.
const { createAgent } = require("../helpers/agent");

test("GET / redirects to the listings", async () => {
  const res = await createAgent().get("/");
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/listings");
});

test.each([
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Service"],
])("%s is a placeholder page, not a 404", async (url, heading) => {
  const res = await createAgent().get(url);
  expect(res.status).toBe(200);
  expect(res.text).toContain(heading);
  expect(res.text).toContain("not written yet");
});

test("the navbar for a visitor links to Sign Up and Login, with clean hrefs", async () => {
  const res = await createAgent().get("/login");
  expect(res.status).toBe(200);
  expect(res.text).toContain('href="/signup"');
  expect(res.text).not.toContain('href="/signup "');
  expect(res.text).toContain('href="/login"');
  expect(res.text).not.toContain("Logout");
  expect(res.text).not.toContain("Login out");
});

test("the login-required message is not specific to creating a listing", async () => {
  const agent = createAgent();
  await agent.get("/listings/new");
  const res = await agent.get("/login");
  expect(res.text).toContain("You must be logged in to do that");
  expect(res.text).not.toContain("create new listing");
});
