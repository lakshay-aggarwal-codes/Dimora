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
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    // Documented exception: map.js reads globals that views/listings/show.ejs
    // defines inline (mapToken, listing) and has top-level values it never reads.
    // P01-T06 rewrites this file (data- attributes); remove this block then.
    files: ["public/js/map.js"],
    languageOptions: {
      globals: { mapboxgl: "readonly", mapToken: "readonly", listing: "readonly" },
    },
    rules: { "no-unused-vars": "off" },
  },
];
