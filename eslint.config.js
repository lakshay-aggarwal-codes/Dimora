// ESLint 9 flat config (CommonJS). Rules: ESLint "recommended" only.
// Environments: Node for server code, browser for public/js.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    ignores: ["public/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["tests/**/*.js", "jest.config.js"],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    // map.js is a browser script that relies on the Mapbox GL global.
    files: ["public/js/map.js"],
    languageOptions: { globals: { mapboxgl: "readonly" } },
  },
];
