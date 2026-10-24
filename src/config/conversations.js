// Messaging settings (P11-T02). Plain constants.
const LIMITS = Object.freeze({
  body: 1000, // characters in one message
  preview: 120, // characters of the last message kept on the conversation
});

const PAGE_SIZE = 50; // messages per page of a thread
const LIST_SIZE = 20; // conversations per page of the list

module.exports = { LIMITS, PAGE_SIZE, LIST_SIZE };
