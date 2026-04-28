const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const EVENTS_LOG_FILE = path.join(DATA_DIR, "events.log");

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const QUARANTINE_DIR = path.join(DATA_DIR, "quarantine");
const RECOVERY_REPORTS_DIR = path.join(DATA_DIR, "recovery-reports");
const RECOVERY_STATE_FILE = path.join(DATA_DIR, "recovery-state.json");

function generateSecureApiKey() {
  return "crk_" + crypto.randomBytes(32).toString("hex");
}

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null;
const RECOVERY_REQUIRES_AUTH = process.env.RECOVERY_REQUIRES_AUTH !== "false";
const RECOVERY_AUTH_HEADER = process.env.RECOVERY_AUTH_HEADER || "X-Recovery-Key";

function parseEnvNumber(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

module.exports = {
  HOST: process.env.HOST || "127.0.0.1",
  PORT: Number(process.env.PORT || 4321),
  ROOT_DIR,
  DATA_DIR,
  SESSION_DIR,
  LEADERBOARD_FILE,
  EVENTS_LOG_FILE,
  BACKUP_DIR,
  QUARANTINE_DIR,
  RECOVERY_REPORTS_DIR,
  RECOVERY_STATE_FILE,
  SESSION_TTL_MS: parseEnvNumber("SESSION_TTL_MS", 15 * 60 * 1000),
  MAX_EVENTS_PER_SESSION: parseEnvNumber("MAX_EVENTS_PER_SESSION", 1000),
  MAX_EVENT_FUTURE_SKEW_MS: parseEnvNumber("MAX_EVENT_FUTURE_SKEW_MS", 30 * 1000),
  MAX_EVENT_PAST_SKEW_MS: parseEnvNumber("MAX_EVENT_PAST_SKEW_MS", 5 * 1000),
  LOCK_TIMEOUT_MS: parseEnvNumber("LOCK_TIMEOUT_MS", 5 * 1000),
  LOCK_RETRY_MS: parseEnvNumber("LOCK_RETRY_MS", 100),
  MAX_COMBO_VALUE: parseEnvNumber("MAX_COMBO_VALUE", 100),
  MAX_EVENTS_PER_SECOND: parseEnvNumber("MAX_EVENTS_PER_SECOND", 20),
  MIN_EVENT_INTERVAL_MS: parseEnvNumber("MIN_EVENT_INTERVAL_MS", 10),
  EVENT_FREQUENCY_WINDOW_MS: parseEnvNumber("EVENT_FREQUENCY_WINDOW_MS", 1000),
  ADMIN_API_KEY,
  RECOVERY_REQUIRES_AUTH,
  RECOVERY_AUTH_HEADER,
  generateSecureApiKey
};
