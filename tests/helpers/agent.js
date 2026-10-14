// supertest helpers around the real app (createApp) with test settings:
// in-memory session store, silent logger, mocked Cloudinary/Mapbox.
const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/config/logger");
const { testConfig } = require("./config");

function createTestApp({ logger, config } = {}) {
  return createApp({
    config: config || testConfig(),
    sessionStore: new session.MemoryStore(),
    logger: logger || createLogger({ level: "silent" }),
  });
}

/** A cookie-keeping agent, so a login persists across requests. */
function createAgent(options) {
  return request.agent(createTestApp(options));
}

// Extension point: once CSRF protection exists (P01-T10) this fetches the token
// for the agent's session and `login`/form helpers send it. Until then there is
// nothing to fetch.
async function getCsrfToken() {
  return undefined;
}

/** Logs the agent in through the real /login form. */
async function login(agent, { username, password }) {
  const csrf = await getCsrfToken(agent);
  const body = { username, password };
  if (csrf) body._csrf = csrf;
  const res = await agent.post("/login").type("form").send(body);
  if (res.status !== 302 || res.headers.location === "/login") {
    throw new Error(
      `login helper: expected a redirect away from /login, got ${res.status} ${res.headers.location}`,
    );
  }
  return agent;
}

module.exports = { createTestApp, createAgent, login, getCsrfToken };
