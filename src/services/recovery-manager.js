const path = require("path");
const fsp = require("fs/promises");

const {
  BACKUP_DIR,
  QUARANTINE_DIR,
  RECOVERY_REPORTS_DIR,
  RECOVERY_STATE_FILE,
  RECOVERY_TEMP_DIR,
  RECOVERY_HISTORY_DIR,
  RECOVERY_EVENT_LOG,
  SESSION_DIR,
  EVENTS_LOG_FILE,
  LEADERBOARD_FILE,
  RECOVERY_TRANSACTION_MODE,
  OPERATION_DEFAULT_MAX_RETRIES,
  OPERATION_DEFAULT_RETRY_DELAY_MS,
  OPERATION_DEFAULT_TIMEOUT_MS,
  OPERATION_DEFAULT_MAX_CONCURRENCY,
  OPERATION_AUTO_ROLLBACK,
  OPERATION_PERSIST_EVENTS
} = require("../config");
const { ensureDir, readJson, writeJsonAtomic } = require("../utils/file-store");
const { createOperationManager, OPERATION_STATES, OPERATION_EVENT_TYPES, DEFAULT_OPERATION_CONFIG } = require("./operation-manager");

const RECOVERY_STATES = OPERATION_STATES;
const RECOVERY_EVENT_TYPES = OPERATION_EVENT_TYPES;
const RECOVERY_OPERATION_TYPE = "recovery";

let recoveryServiceModule = null;

async function getRecoveryService() {
  if (!recoveryServiceModule) {
    recoveryServiceModule = require("./recovery-service");
  }
  return recoveryServiceModule;
}

const recoveryOperationManager = createOperationManager({
  operationName: "recovery",
  backupDir: BACKUP_DIR,
  reportsDir: RECOVERY_REPORTS_DIR,
  stateFile: RECOVERY_STATE_FILE,
  tempDir: RECOVERY_TEMP_DIR,
  historyDir: RECOVERY_HISTORY_DIR,
  eventLogFile: RECOVERY_EVENT_LOG,
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
  defaultConfig: {
    maxRetries: OPERATION_DEFAULT_MAX_RETRIES,
    retryDelayMs: OPERATION_DEFAULT_RETRY_DELAY_MS,
    timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
    concurrencyKey: "recovery",
    maxConcurrency: OPERATION_DEFAULT_MAX_CONCURRENCY,
    autoRollbackOnFailure: OPERATION_AUTO_ROLLBACK,
    persistEvents: OPERATION_PERSIST_EVENTS
  },
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

async function registerRecoveryOperation() {
  if (recoveryOperationManager.getRegisteredOperation(RECOVERY_OPERATION_TYPE)) {
    return;
  }

  recoveryOperationManager.registerOperation({
    type: RECOVERY_OPERATION_TYPE,
    handler: async ({ operation, progress, isInterrupted }) => {
      const options = {
        dryRun: operation.dryRun,
        createBackup: operation.metadata?.createBackup !== false,
        quarantineCorrupted: operation.metadata?.quarantineCorrupted !== false,
        enableTransaction: operation.metadata?.enableTransaction !== false,
        logFilePath: operation.metadata?.logFilePath || null,
        onProgress: (p) => {
          progress(p);
        }
      };

      const serviceModule = await getRecoveryService();
      const service = await serviceModule.createRecoveryService(options);
      const report = await service.runRecovery();

      return report;
    },
    rollbackHandler: async ({ operation, backupResult, progress }) => {
      if (!backupResult || !backupResult.success) {
        return { success: false, reason: "no_backup" };
      }

      const result = await recoveryOperationManager.restoreFromBackup(backupResult.backupId);
      return result;
    },
    config: {
      maxRetries: 0,
      timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
      concurrencyKey: "recovery",
      maxConcurrency: 1
    }
  });
}

async function ensureRecoveryDirs() {
  await recoveryOperationManager.ensureOperationDirs();
  await ensureDir(QUARANTINE_DIR);
}

async function quarantineCorruptedLogLines(corruptedLines, logFilePath = EVENTS_LOG_FILE) {
  if (corruptedLines.length === 0) {
    return { success: true, quarantined: 0 };
  }

  await ensureRecoveryDirs();

  const timestamp = recoveryOperationManager.generateTimestamp();
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

  const timestamp = recoveryOperationManager.generateTimestamp();
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
  return recoveryOperationManager.saveOperationReport(report);
}

async function listRecoveryReports() {
  return recoveryOperationManager.listOperationReports();
}

async function getRecoveryReport(reportId) {
  return recoveryOperationManager.getOperationReport(reportId);
}

async function saveRecoveryState(state) {
  return recoveryOperationManager.saveOperationState(state);
}

async function loadRecoveryState() {
  return recoveryOperationManager.loadOperationState();
}

function getCurrentRecoveryState() {
  return recoveryOperationManager.getCurrentOperationState();
}

function isRecoveryInterrupted() {
  return recoveryOperationManager.isInterrupted();
}

async function startRecoveryTracking(options = {}) {
  return recoveryOperationManager.startOperationTracking(options);
}

async function completeRecoveryTracking(report, options = {}) {
  if (typeof options === "boolean") {
    return recoveryOperationManager.completeOperationTracking(report, { success: options });
  }

  return recoveryOperationManager.completeOperationTracking(report, options);
}

async function interruptRecoveryTracking() {
  return recoveryOperationManager.interruptOperationTracking();
}

async function runRecoveryOperation(options = {}) {
  await registerRecoveryOperation();

  const {
    dryRun = true,
    createBackup: _createBackup = true,
    quarantineCorrupted = true,
    enableTransaction = true,
    logFilePath = null,
    metadata = {}
  } = options;

  return recoveryOperationManager.runOperation(RECOVERY_OPERATION_TYPE, {
    dryRun,
    metadata: {
      ...metadata,
      createBackup: _createBackup,
      quarantineCorrupted,
      enableTransaction,
      logFilePath
    }
  });
}

function getRecoveryOperation(operationId) {
  return recoveryOperationManager.getOperation(operationId);
}

function listActiveRecoveryOperations() {
  return recoveryOperationManager.listActiveOperations();
}

async function cancelRecoveryOperation(operationId) {
  return recoveryOperationManager.cancelOperation(operationId);
}

async function listRecoveryHistory(options = {}) {
  return recoveryOperationManager.listOperationHistory(options);
}

async function getRecoveryHistory(operationId) {
  return recoveryOperationManager.getOperationHistory(operationId);
}

async function readRecoveryEvents(options = {}) {
  return recoveryOperationManager.readOperationEvents(options);
}

function onRecoveryEvent(eventType, listener) {
  return recoveryOperationManager.onOperationEvent(eventType, listener);
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

registerRecoveryOperation().catch(() => {});

module.exports = {
  RECOVERY_STATES,
  RECOVERY_EVENT_TYPES,
  RECOVERY_OPERATION_TYPE,
  registerRecoveryOperation,
  generateTimestamp: recoveryOperationManager.generateTimestamp,
  ensureRecoveryDirs,
  createBackup: recoveryOperationManager.createBackup,
  listBackups: recoveryOperationManager.listBackups,
  restoreFromBackup: recoveryOperationManager.restoreFromBackup,
  quarantineCorruptedLogLines,
  quarantineCorruptedSession,
  listQuarantinedItems,
  saveRecoveryReport,
  listRecoveryReports,
  getRecoveryReport,
  saveRecoveryState,
  loadRecoveryState,
  getCurrentRecoveryState,
  setInterrupted: recoveryOperationManager.setInterrupted,
  isRecoveryInterrupted,
  updateProgress: recoveryOperationManager.updateProgress,
  getCurrentProgress: recoveryOperationManager.getCurrentProgress,
  startRecoveryTracking,
  completeRecoveryTracking,
  interruptRecoveryTracking,
  createTransaction: recoveryOperationManager.createTransaction,
  rollbackTransaction: recoveryOperationManager.rollbackTransaction,
  getActiveTransactionId: recoveryOperationManager.getActiveTransactionId,
  clearActiveTransaction: recoveryOperationManager.clearActiveTransaction,
  validateRecoveryResult,
  getTransactionMode: recoveryOperationManager.getTransactionMode,
  runRecoveryOperation,
  getRecoveryOperation,
  listActiveRecoveryOperations,
  cancelRecoveryOperation,
  listRecoveryHistory,
  getRecoveryHistory,
  readRecoveryEvents,
  onRecoveryEvent,
  registerOperation: recoveryOperationManager.registerOperation,
  getRegisteredOperation: recoveryOperationManager.getRegisteredOperation,
  listRegisteredOperations: recoveryOperationManager.listRegisteredOperations,
  emitOperationEvent: recoveryOperationManager.emitOperationEvent,
  onOperationEvent: recoveryOperationManager.onOperationEvent,
  createOperation: recoveryOperationManager.createOperation,
  updateOperation: recoveryOperationManager.updateOperation,
  executeOperation: recoveryOperationManager.executeOperation,
  listActiveOperations: recoveryOperationManager.listActiveOperations,
  listOperationHistory: recoveryOperationManager.listOperationHistory,
  getOperationHistory: recoveryOperationManager.getOperationHistory,
  readOperationEvents: recoveryOperationManager.readOperationEvents
};
