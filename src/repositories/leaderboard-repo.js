const {
  LEADERBOARD_FILE
} = require("../config");
const {
  ensureJsonFile,
  readJson,
  writeJsonAtomic
} = require("../utils/file-store");
const { withFileLock } = require("../utils/lock");

async function ensureLeaderboardStorage() {
  await ensureJsonFile(LEADERBOARD_FILE, []);
}

async function listLeaderboardEntries() {
  const entries = await readJson(LEADERBOARD_FILE, []);
  return Array.isArray(entries) ? entries : [];
}

async function addLeaderboardEntry(entry) {
  await ensureLeaderboardStorage();

  return withFileLock(LEADERBOARD_FILE, async () => {
    const entries = await listLeaderboardEntries();
    const existingEntry = entries.find((item) => item.sessionId === entry.sessionId);
    if (existingEntry) {
      return existingEntry;
    }

    entries.push(entry);
    await writeJsonAtomic(LEADERBOARD_FILE, entries);
    return entry;
  });
}

module.exports = {
  ensureLeaderboardStorage,
  listLeaderboardEntries,
  addLeaderboardEntry
};
