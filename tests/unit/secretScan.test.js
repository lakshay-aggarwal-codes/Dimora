// P17-T04: the secret scanner finds what it should, ignores what it should,
// and the project itself is clean. Fake secrets are assembled from pieces so
// this file does not trip the scanner it tests.
const path = require("node:path");
const { scanText, scanTree } = require("../../scripts/lib/secret-scan");

const j = (...parts) => parts.join("");

describe("scanText: finds real-looking secrets", () => {
  test("database URI with a password, never printing the password", () => {
    const text = j("MONGODB_URI=mongodb", "+srv://admin:", "Hunter2Hunter2", "@cluster0.example.mongodb.net/db");
    const [finding] = scanText("src/config.js", text);
    expect(finding.rule).toBe("database URI with a password");
    expect(finding.line).toBe(1);
    expect(JSON.stringify(finding).includes("Hunter2Hunter2")).toBe(false);
    expect(finding.preview.startsWith("Hunt")).toBe(true);
  });

  test("Mapbox secret token, private key, AWS key, GitHub token, Cloudinary URL", () => {
    const cases = [
      [j("const t = 's", "k.eyJ", "1IjoiZGltb3JhIiwiYSI6ImNsMTIzNDU2Nzg5MCJ9.abcdefghij", "'")],
      [j("-----BEGIN RSA ", "PRIVATE KEY-----")],
      [j("key = AKIA", "ABCDEFGHIJKLMNOP")],
      [j("gh", "p_", "a".repeat(36))],
      [j("cloudinary", "://123456789012345:", "AbCdEfGhIjKlMnOp", "@mycloud")],
    ];
    for (const [text] of cases) expect(scanText("src/x.js", text).length).toBe(1);
  });

  test("a literal value for a secret setting in source code", () => {
    const text = j("SESSION_", "SECRET = '", "a1b2c3d4e5f6a7b8c9d0e1f2", "'");
    expect(scanText("src/app.js", text)[0].rule).toBe("literal value for SESSION_SECRET");
  });

  test("reports the line number", () => {
    const text = j("line one\nline two\nkey=AKIA", "ABCDEFGHIJKLMNOP");
    expect(scanText("a.txt", text)[0].line).toBe(3);
  });
});

describe("scanText: leaves harmless text alone", () => {
  test("placeholders and empty examples", () => {
    expect(scanText("README.md", "MONGODB_URI=mongodb+srv://<user>:<password>@cluster.example.net/db")).toEqual([]);
    expect(scanText("README.md", "mongodb://user:password@localhost:27017/dimora")).toEqual([]);
    expect(scanText(".env.example", "SESSION_SECRET=\nCLOUDINARY_API_SECRET=")).toEqual([]);
    expect(scanText("src/config/env.js", 'SESSION_SECRET: Joi.string().required(),')).toEqual([]);
    expect(scanText("src/x.js", "const secret = process.env.SESSION_SECRET;")).toEqual([]);
    expect(scanText("src/x.js", "SESSION_SECRET=${SESSION_SECRET}")).toEqual([]);
  });

  test("test fixtures and docs may hold fake values for settings, but strong patterns still count everywhere", () => {
    const fixture = j("SESSION_", "SECRET: 'test-secret-value-that-is-long-enough'");
    expect(scanText("tests/unit/env.test.js", fixture)).toEqual([]);
    expect(scanText("docs/SECURITY.md", fixture)).toEqual([]);
    const strong = j("key = AKIA", "ABCDEFGHIJKLMNOP");
    expect(scanText("tests/unit/x.test.js", strong).length).toBe(1);
  });

  test("a public Mapbox token is not a secret", () => {
    expect(scanText("src/x.js", j("p", "k.eyJ", "1IjoiZGltb3JhIiwiYSI6ImNsMTIzNDU2Nzg5MCJ9.abcdefghij"))).toEqual([]);
  });
});

describe("the project", () => {
  test("has no committed secrets (working tree, .env excluded because it is git-ignored)", () => {
    const findings = scanTree(path.join(__dirname, "..", ".."));
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}`)).toEqual([]);
  });
});
