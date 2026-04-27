const path = require("path");

const { SESSION_DIR } = require("../config");
const { ensureDir, listJsonFiles, readJson, writeJsonAtomic } = require("../utils/file-store");

function getSessionFilePath(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

async function ensureSessionStorage() {
  await ensureDir(SESSION_DIR);
}

async function getSessionById(sessionId) {
  return readJson(getSessionFilePath(sessionId), null);
}

async function saveSession(session) {
  await ensureSessionStorage();
  await writeJsonAtomic(getSessionFilePath(session.id), session);
  return session;
}

async function listSessions() {
  await ensureSessionStorage();
  const files = await listJsonFiles(SESSION_DIR);
  const sessions = await Promise.all(files.map((filePath) => readJson(filePath, null)));
  return sessions.filter(Boolean);
}

module.exports = {
  ensureSessionStorage,
  getSessionById,
  saveSession,
  listSessions,
  getSessionFilePath
};
