const path = require("path");
const fsp = require("fs/promises");
const {
  BACKUP_DIR,
  QUARANTINE_DIR,
  RECOVERY_REPORTS_DIR,
  RECOVERY_STATE_FILE,
  RECOVERY_TEMP_DIR,
  SESSION_DIR,
  EVENTS_LOG_FILE,
  LEADERBOARD_FILE,
  RECOVERY_TRANSACTION_MODE
} = require("../config");
const { ensureDir, readJson, writeJsonAtomic } = require("../utils/file-store");
const { createOperationManager, OPERATION_STATES } = require("./operation-manager");

const RECOVERY_STATES = OPERATION_STATES;

const recoveryOperationManager = createOperationManager({
  operationName: "recovery",
  backupDir: BACKUP_DIR,
  reportsDir: RECOVERY_REPORTS_DIR,
  stateFile: RECOVERY_STATE_FILE,
  tempDir: RECOVERY_TEMP_DIR,
  transactionModeEnabled: RECOVERY_TRANSACTION_MODE,
  trackedResources: [
    {
      key: "sessions",
      type: "directory",
      targetPath: SESSION_DIR,
      backupPath: "sessions"
    },
    {
      key: "events_log",
      type: "file",
      targetPath: EVENTS_LOG_FILE,
      backupPath: "events.log"
    },
    {
      key: "leaderboard",
      type: "file",
      targetPath: LEADERBOARD_FILE,
      backupPath: "leaderboard.json"
    }
  ],
  resolveManifestItem(item) {
    if (!item || !item.type) {
      return null;
    }

    if (item.type === "session" && item.file) {
      return {
        targetPath: path.join(SESSION_DIR, item.file),
        resourceType: "file",
        relativeBackupPath: item.path
      };
    }

    if (item.type === "events_log") {
      return {
        targetPath: EVENTS_LOG_FILE,
        resourceType: "file",
        relativeBackupPath: item.path
      };
    }

    if (item.type === "leaderboard") {
      return {
        targetPath: LEADERBOARD_FILE,
        resourceType: "file",
        relativeBackupPath: item.path
      };
    }

    return null;
  }
});

const {
  generateTimestamp,
  ensureOperationDirs,
  createBackup,
  listBackups,
  restoreFromBackup,
  saveOperationReport,
  listOperationReports,
  getOperationReport,
  saveOperationState,
  loadOperationState,
  getCurrentOperationState,
  setInterrupted,
  isInterrupted,
  updateProgress,
  getCurrentProgress,
  startOperationTracking,
  completeOperationTracking,
  interruptOperationTracking,
  createTransaction,
  rollbackTransaction,
  getActiveTransactionId,
  clearActiveTransaction,
  getTransactionMode
} = recoveryOperationManager;

async function ensureRecoveryDirs() {
  await ensureOperationDirs();
  await ensureDir(QUARANTINE_DIR);
}

async function quarantineCorruptedLogLines(corruptedLines, logFilePath = EVENTS_LOG_FILE) {
  if (corruptedLines.length === 0) {
    return { success: true, quarantined: 0 };
  }

  await ensureRecoveryDirs();

  const timestamp = generateTimestamp();
  const quarantineId = `log_corrupt_${timestamp}`;
  const quarantinePath = path.join(QUARANTINE_DIR, `${quarantineId}.json`);

  const quarantineData = {
    id: quarantineId,
    timestamp: new Date().toISOString(),
    type: "corrupted_log_lines",
    sourceFile: logFilePath,
    corruptedLines: corruptedLines.map((line) => ({
      lineNumber: line.lineNumber,
      raw: line.raw,
      error: line.error,
      errorType: line.errorType
    }))
  };

  await writeJsonAtomic(quarantinePath, quarantineData);

  return {
    success: true,
    quarantineId,
    quarantined: corruptedLines.length
  };
}

async function quarantineCorruptedSession(sessionId, reason, sessionData = null) {
  await ensureRecoveryDirs();

  const timestamp = generateTimestamp();
  const quarantineId = `session_${sessionId}_${timestamp}`;
  const quarantinePath = path.join(QUARANTINE_DIR, `${quarantineId}.json`);

  const quarantineData = {
    id: quarantineId,
    timestamp: new Date().toISOString(),
    type: "corrupted_session",
    sessionId,
    reason,
    sessionData
  };

  await writeJsonAtomic(quarantinePath, quarantineData);

  return {
    success: true,
    quarantineId,
    sessionId
  };
}

async function listQuarantinedItems() {
  await ensureRecoveryDirs();

  try {
    const files = await fsp.readdir(QUARANTINE_DIR);
    const items = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      try {
        const filePath = path.join(QUARANTINE_DIR, file);
        const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));
        items.push(data);
      } catch {
        items.push({
          id: file.replace(".json", ""),
          error: "Failed to read quarantined item"
        });
      }
    }

    return {
      success: true,
      items
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      items: []
    };
  }
}

async function saveRecoveryReport(report) {
  return saveOperationReport(report);
}

async function listRecoveryReports() {
  return listOperationReports();
}

async function getRecoveryReport(reportId) {
  return getOperationReport(reportId);
}

async function saveRecoveryState(state) {
  return saveOperationState(state);
}

async function loadRecoveryState() {
  return loadOperationState();
}

function getCurrentRecoveryState() {
  return getCurrentOperationState();
}

function isRecoveryInterrupted() {
  return isInterrupted();
}

async function startRecoveryTracking(options = {}) {
  return startOperationTracking(options);
}

async function completeRecoveryTracking(report, options = {}) {
  if (typeof options === "boolean") {
    return completeOperationTracking(report, { success: options });
  }

  return completeOperationTracking(report, options);
}

async function interruptRecoveryTracking() {
  return interruptOperationTracking();
}

async function validateRecoveryResult(eventsCount, sessionsCount, report) {
  const issues = [];
  const warnings = [];

  if (!report || !report.success) {
    issues.push({
      type: "recovery_failed",
      message: "Recovery process reported failure"
    });
    return { valid: false, issues, warnings };
  }

  if (report.summary.recovered === 0 && report.summary.skipped === 0 && report.summary.failed === 0) {
    warnings.push({
      type: "no_sessions_processed",
      message: "No sessions were processed during recovery"
    });
  }

  if (report.summary.totalSessions !== sessionsCount) {
    issues.push({
      type: "session_count_mismatch",
      message: `Session count mismatch: expected=${sessionsCount}, actual=${report.summary.totalSessions}`
    });
  }

  if (report.summary.totalSessions !== report.summary.recovered + report.summary.skipped + report.summary.failed) {
    issues.push({
      type: "session_summary_mismatch",
      message: `Session summary mismatch: total=${report.summary.totalSessions}, sum=${report.summary.recovered + report.summary.skipped + report.summary.failed}`
    });
  }

  const recoveredEvents = (report.details.sessions || []).reduce((count, session) => count + (session.eventCount || 0), 0);
  if (eventsCount > 0 && recoveredEvents === 0 && report.summary.totalSessions > 0) {
    issues.push({
      type: "event_replay_mismatch",
      message: `Parsed ${eventsCount} events but recovered event count is 0`
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    summary: {
      totalSessions: report.summary.totalSessions,
      recovered: report.summary.recovered,
      skipped: report.summary.skipped,
      failed: report.summary.failed,
      eventsCount,
      recoveredEvents
    }
  };
}

module.exports = {
  RECOVERY_STATES,
  generateTimestamp,
  ensureRecoveryDirs,
  createBackup,
  listBackups,
  restoreFromBackup,
  quarantineCorruptedLogLines,
  quarantineCorruptedSession,
  listQuarantinedItems,
  saveRecoveryReport,
  listRecoveryReports,
  getRecoveryReport,
  saveRecoveryState,
  loadRecoveryState,
  getCurrentRecoveryState,
  setInterrupted,
  isRecoveryInterrupted,
  updateProgress,
  getCurrentProgress,
  startRecoveryTracking,
  completeRecoveryTracking,
  interruptRecoveryTracking,
  createTransaction,
  rollbackTransaction,
  getActiveTransactionId,
  clearActiveTransaction,
  validateRecoveryResult,
  getTransactionMode
};
