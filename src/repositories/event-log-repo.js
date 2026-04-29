const { EVENTS_LOG_FILE } = require("../config");
const { appendLine, ensureFile } = require("../utils/file-store");

async function ensureEventLogStorage() {
  await ensureFile(EVENTS_LOG_FILE, "");
}

async function appendEventLog(eventRecord) {
  await ensureEventLogStorage();
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(eventRecord));
}

module.exports = {
  ensureEventLogStorage,
  appendEventLog
};
