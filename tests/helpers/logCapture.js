// A pino logger that writes to memory, for asserting on what gets logged.
const { Writable } = require("node:stream");
const { createLogger } = require("../../src/config/logger");

function memoryLog(level = "info") {
  const lines = [];
  const destination = new Writable({
    write(chunk, enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    logger: createLogger({ level, destination }),
    text: () => lines.join(""),
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

module.exports = { memoryLog };
