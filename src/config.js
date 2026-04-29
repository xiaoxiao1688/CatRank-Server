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
const RECOVERY_TEMP_DIR = path.join(DATA_DIR, "recovery-temp");
const RECOVERY_HISTORY_DIR = path.join(DATA_DIR, "recovery-history");
const RECOVERY_EVENT_LOG = path.join(DATA_DIR, "recovery-events.log");

const EXPORT_REPORTS_DIR = path.join(DATA_DIR, "export-reports");
const EXPORT_STATE_FILE = path.join(DATA_DIR, "export-state.json");
const EXPORT_TEMP_DIR = path.join(DATA_DIR, "export-temp");
const EXPORT_HISTORY_DIR = path.join(DATA_DIR, "export-history");
const EXPORT_EVENT_LOG = path.join(DATA_DIR, "export-events.log");
const EXPORT_OUTPUT_DIR = path.join(DATA_DIR, "exports");

const IMPORT_REPORTS_DIR = path.join(DATA_DIR, "import-reports");
const IMPORT_STATE_FILE = path.join(DATA_DIR, "import-state.json");
const IMPORT_TEMP_DIR = path.join(DATA_DIR, "import-temp");
const IMPORT_HISTORY_DIR = path.join(DATA_DIR, "import-history");
const IMPORT_EVENT_LOG = path.join(DATA_DIR, "import-events.log");
const IMPORT_INPUT_DIR = path.join(DATA_DIR, "imports");

const OPERATION_DEFAULT_MAX_RETRIES = parseEnvNumber("OPERATION_DEFAULT_MAX_RETRIES", 3);
const OPERATION_DEFAULT_RETRY_DELAY_MS = parseEnvNumber("OPERATION_DEFAULT_RETRY_DELAY_MS", 1000);
const OPERATION_DEFAULT_TIMEOUT_MS = parseEnvNumber("OPERATION_DEFAULT_TIMEOUT_MS", 300000);
const OPERATION_DEFAULT_MAX_CONCURRENCY = parseEnvNumber("OPERATION_DEFAULT_MAX_CONCURRENCY", 1);
const OPERATION_AUTO_ROLLBACK = parseEnvBoolean("OPERATION_AUTO_ROLLBACK", true);
const OPERATION_PERSIST_EVENTS = parseEnvBoolean("OPERATION_PERSIST_EVENTS", true);

function generateDefaultApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

function parseEnvBoolean(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const lower = value.toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

function parseEnvNumber(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const RECOVERY_API_KEY = process.env.RECOVERY_API_KEY || generateDefaultApiKey();
const RECOVERY_REQUIRE_AUTH = parseEnvBoolean("RECOVERY_REQUIRE_AUTH", false);

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
  RECOVERY_TEMP_DIR,
  RECOVERY_HISTORY_DIR,
  RECOVERY_EVENT_LOG,
  RECOVERY_API_KEY,
  RECOVERY_REQUIRE_AUTH,
  EXPORT_REPORTS_DIR,
  EXPORT_STATE_FILE,
  EXPORT_TEMP_DIR,
  EXPORT_HISTORY_DIR,
  EXPORT_EVENT_LOG,
  EXPORT_OUTPUT_DIR,
  IMPORT_REPORTS_DIR,
  IMPORT_STATE_FILE,
  IMPORT_TEMP_DIR,
  IMPORT_HISTORY_DIR,
  IMPORT_EVENT_LOG,
  IMPORT_INPUT_DIR,
  OPERATION_DEFAULT_MAX_RETRIES,
  OPERATION_DEFAULT_RETRY_DELAY_MS,
  OPERATION_DEFAULT_TIMEOUT_MS,
  OPERATION_DEFAULT_MAX_CONCURRENCY,
  OPERATION_AUTO_ROLLBACK,
  OPERATION_PERSIST_EVENTS,
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
  RECOVERY_TRANSACTION_MODE: parseEnvBoolean("RECOVERY_TRANSACTION_MODE", true)
};
