// supertest helpers around the real app (createApp) with test settings:
// in-memory session store, silent logger, mocked Cloudinary/Mapbox.
const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/config/logger");
const { testConfig } = require("./config");

function createTestApp({ logger, config, emailService } = {}) {
  return createApp({
    config: config || testConfig(),
    sessionStore: new session.MemoryStore(),
    logger: logger || createLogger({ level: "silent" }),
    emailService,
  });
}

const CSRF_META = /<meta name="csrf-token" content="([^"]*)">/;

/**
 * Fetches the CSRF token of the agent's current session from a rendered page.
 * Always asks again: logging in or out regenerates the session and the token.
 */
async function getCsrfToken(agent) {
  const res = await agent.get("/login");
  const match = CSRF_META.exec(res.text || "");
  if (!match || !match[1]) {
    throw new Error(
      `getCsrfToken: no csrf-token meta tag in GET /login (status ${res.status})`,
    );
  }
  return match[1];
}

const MUTATING = ["post", "put", "patch", "delete"];
const TERMINAL = new Set(["then", "catch", "finally", "end", "pipe"]);

/**
 * Makes POST/PUT/PATCH/DELETE send `X-CSRF-Token` for the agent's current
 * session unless the test set the header itself. Existing tests therefore keep
 * working unchanged; tests of the CSRF protection use `createAgent({ csrf:
 * false })` to get a raw agent.
 *
 * The request object is built only when it is awaited (after the token is
 * fetched): chained calls such as .type().send().attach() are recorded and
 * replayed on the real supertest request.
 */
function withCsrf(agent) {
  for (const method of MUTATING) {
    const original = agent[method].bind(agent);
    agent[method] = (...args) => {
      const calls = [];
      const build = async () => {
        const token = await getCsrfToken(agent);
        const test = original(...args);
        test.set("X-CSRF-Token", token);
        for (const [name, callArgs] of calls) {
          // A header the test set itself (even "X-CSRF-Token") wins.
          test[name](...callArgs);
        }
        // Wrapped: a supertest request is thenable and must not be returned
        // from an async function (that would send it right away).
        return { test };
      };
      const proxy = new Proxy(function recordedRequest() {}, {
        get(_target, name) {
          if (TERMINAL.has(name)) {
            return (...callArgs) =>
              build().then(({ test }) => test[name](...callArgs));
          }
          return (...callArgs) => {
            calls.push([name, callArgs]);
            return proxy;
          };
        },
      });
      return proxy;
    };
  }
  return agent;
}

/** A cookie-keeping agent, so a login persists across requests. */
function createAgent({ csrf = true, ...options } = {}) {
  const agent = request.agent(createTestApp(options));
  return csrf ? withCsrf(agent) : agent;
}

/** Logs the agent in through the real /login form. */
async function login(agent, { username, password }) {
  const csrf = await getCsrfToken(agent);
  const res = await agent
    .post("/login")
    .set("X-CSRF-Token", csrf)
    .type("form")
    .send({ username, password });
  if (res.status !== 302 || res.headers.location === "/login") {
    throw new Error(
      `login helper: expected a redirect away from /login, got ${res.status} ${res.headers.location}`,
    );
  }
  return agent;
}

module.exports = { createTestApp, createAgent, login, getCsrfToken };
