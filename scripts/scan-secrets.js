// Scans the project for committed secrets (P17-T04). See scripts/lib/secret-scan.js.
//
//   npm run scan:secrets
//   git log --all -p | node scripts/scan-secrets.js --stdin      (the whole history)
// Exit code 1 when something is found. A finding means: rotate that secret, then remove it.
const path = require("node:path");
const { scanText, scanTree } = require("./lib/secret-scan");

function report(findings) {
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.preview}`);
  console.log(findings.length ? `${findings.length} possible secret(s) found.` : "No secrets found.");
}

async function main() {
  if (process.argv.includes("--stdin")) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const findings = scanText("(stdin)", text);
    report(findings);
    return findings.length ? 1 : 0;
  }
  const findings = scanTree(path.join(__dirname, ".."));
  report(findings);
  return findings.length ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
});
