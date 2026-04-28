const path = require("path");
const fsp = require("fs/promises");
const {
  BACKUP_DIR,
  QUARANTINE_DIR,
  RECOVERY_REPORTS_DIR,
  RECOVERY_STATE_FILE,
  SESSION_DIR,
  EVENTS_LOG_FILE,
  LEADERBOARD_FILE
} = require("../config");
const { ensureDir, readJson, writeJsonAtomic } = require("../utils/file-store");
const { createId } = require("../utils/id");

const RECOVERY_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  INTERRUPTED: "interrupted",
  COMPLETED: "completed",
  FAILED: "failed",
  ROLLING_BACK: "rolling_back",
  ROLLED_BACK: "rolled_back"
};

const ROLLBACK_TRIGGERS = {
  INTERRUPT: "interrupt",
  ERROR: "error",
  MANUAL: "manual"
};

let currentRecoveryState = null;
let isInterrupted = false;
let currentProgress = null;
let activeTransaction = null;

function generateTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureRecoveryDirs() {
  await ensureDir(BACKUP_DIR);
  await ensureDir(QUARANTINE_DIR);
  await ensureDir(RECOVERY_REPORTS_DIR);
}

async function createBackupFn(label = "pre-recovery") {
  await ensureRecoveryDirs();
  
  const timestamp = generateTimestamp();
  const backupId = `backup_${timestamp}_${createId("bkp")}`;
  const backupPath = path.join(BACKUP_DIR, backupId);
  
  await ensureDir(backupPath);
  
  const backupManifest = {
    id: backupId,
    timestamp: new Date().toISOString(),
    label,
    items: []
  };

  try {
    const sessionsBackupPath = path.join(backupPath, "sessions");
    await ensureDir(sessionsBackupPath);
    
    try {
      const sessionFiles = await fsp.readdir(SESSION_DIR);
      for (const file of sessionFiles) {
        if (file.endsWith(".json")) {
          const src = path.join(SESSION_DIR, file);
          const dest = path.join(sessionsBackupPath, file);
          await fsp.copyFile(src, dest);
          backupManifest.items.push({
            type: "session",
            file,
            path: `sessions/${file}`
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await fsp.access(EVENTS_LOG_FILE);
      const logBackupPath = path.join(backupPath, "events.log");
      await fsp.copyFile(EVENTS_LOG_FILE, logBackupPath);
      backupManifest.items.push({
        type: "events_log",
        path: "events.log"
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await fsp.access(LEADERBOARD_FILE);
      const leaderboardBackupPath = path.join(backupPath, "leaderboard.json");
      await fsp.copyFile(LEADERBOARD_FILE, leaderboardBackupPath);
      backupManifest.items.push({
        type: "leaderboard",
        path: "leaderboard.json"
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const manifestPath = path.join(backupPath, "manifest.json");
    await fsp.writeFile(manifestPath, JSON.stringify(backupManifest, null, 2), "utf-8");

    return {
      success: true,
      backupId,
      backupPath,
      manifest: backupManifest
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      backupId: null
    };
  }
}

async function listBackups() {
  await ensureRecoveryDirs();
  
  try {
    const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("backup_")) {
        const manifestPath = path.join(BACKUP_DIR, entry.name, "manifest.json");
        try {
          const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
          backups.push(manifest);
        } catch (error) {
          backups.push({
            id: entry.name,
            timestamp: null,
            label: "unknown",
            error: "Failed to read manifest"
          });
        }
      }
    }

    backups.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return {
      success: true,
      backups
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      backups: []
    };
  }
}

async function restoreFromBackup(backupId) {
  await ensureRecoveryDirs();
  
  const backupPath = path.join(BACKUP_DIR, backupId);
  const manifestPath = path.join(backupPath, "manifest.json");

  try {
    await fsp.access(backupPath);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));

    for (const item of manifest.items) {
      const src = path.join(backupPath, item.path);
      
      if (item.type === "session") {
        const dest = path.join(SESSION_DIR, item.file);
        await fsp.copyFile(src, dest);
      } else if (item.type === "events_log") {
        await fsp.copyFile(src, EVENTS_LOG_FILE);
      } else if (item.type === "leaderboard") {
        await fsp.copyFile(src, LEADERBOARD_FILE);
      }
    }

    return {
      success: true,
      backupId,
      restoredItems: manifest.items.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      backupId
    };
  }
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
    corruptedLines: corruptedLines.map(cl => ({
      lineNumber: cl.lineNumber,
      raw: cl.raw,
      error: cl.error,
      errorType: cl.errorType
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
      if (file.endsWith(".json")) {
        try {
          const filePath = path.join(QUARANTINE_DIR, file);
          const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));
          items.push(data);
        } catch (error) {
          items.push({
            id: file.replace(".json", ""),
            error: "Failed to read quarantined item"
          });
        }
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
  await ensureRecoveryDirs();
  
  const timestamp = generateTimestamp();
  const reportId = `report_${timestamp}`;
  const reportPath = path.join(RECOVERY_REPORTS_DIR, `${reportId}.json`);

  const fullReport = {
    id: reportId,
    ...report
  };

  await writeJsonAtomic(reportPath, fullReport);

  return {
    success: true,
    reportId,
    reportPath
  };
}

async function listRecoveryReports() {
  await ensureRecoveryDirs();
  
  try {
    const files = await fsp.readdir(RECOVERY_REPORTS_DIR);
    const reports = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const filePath = path.join(RECOVERY_REPORTS_DIR, file);
          const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));
          reports.push({
            id: data.id || file.replace(".json", ""),
            timestamp: data.timestamp,
            dryRun: data.dryRun,
            summary: data.summary
          });
        } catch (error) {
          reports.push({
            id: file.replace(".json", ""),
            error: "Failed to read report"
          });
        }
      }
    }

    reports.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return {
      success: true,
      reports
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      reports: []
    };
  }
}

async function getRecoveryReport(reportId) {
  await ensureRecoveryDirs();
  
  const reportPath = path.join(RECOVERY_REPORTS_DIR, `${reportId}.json`);
  
  try {
    const data = JSON.parse(await fsp.readFile(reportPath, "utf-8"));
    return {
      success: true,
      report: data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      report: null
    };
  }
}

async function saveRecoveryState(state) {
  await ensureRecoveryDirs();
  await writeJsonAtomic(RECOVERY_STATE_FILE, state);
  currentRecoveryState = { ...state };
}

async function loadRecoveryState() {
  await ensureRecoveryDirs();
  
  try {
    const state = await readJson(RECOVERY_STATE_FILE, null);
    currentRecoveryState = state;
    return state;
  } catch (error) {
    currentRecoveryState = null;
    return null;
  }
}

function getCurrentRecoveryState() {
  return currentRecoveryState;
}

function setInterrupted(flag = true) {
  isInterrupted = flag;
}

function isRecoveryInterrupted() {
  return isInterrupted;
}

function updateProgress(progress) {
  currentProgress = {
    ...currentProgress,
    ...progress,
    updatedAt: new Date().toISOString()
  };
}

function getCurrentProgress() {
  return currentProgress;
}

async function startRecoveryTracking(options = {}) {
  const { dryRun = true, createBackup: shouldCreateBackup = true } = options;
  
  isInterrupted = false;
  currentProgress = {
    phase: "initializing",
    percent: 0,
    message: "Initializing recovery process..."
  };

  let backupResult = null;
  if (shouldCreateBackup && !dryRun) {
    currentProgress.phase = "backing_up";
    currentProgress.message = "Creating backup before recovery...";
    backupResult = await createBackupFn("pre-recovery");
  }

  const state = {
    status: RECOVERY_STATES.RUNNING,
    dryRun,
    createBackup: shouldCreateBackup,
    backupResult,
    startedAt: new Date().toISOString(),
    progress: currentProgress
  };

  await saveRecoveryState(state);
  
  return state;
}

async function completeRecoveryTracking(report, success = true) {
  const state = {
    status: success ? RECOVERY_STATES.COMPLETED : RECOVERY_STATES.FAILED,
    completedAt: new Date().toISOString(),
    reportId: null
  };

  if (report && !report.dryRun) {
    const saveResult = await saveRecoveryReport(report);
    if (saveResult.success) {
      state.reportId = saveResult.reportId;
    }
  }

  await saveRecoveryState(state);
  
  currentProgress = {
    phase: success ? "completed" : "failed",
    percent: 100,
    message: success ? "Recovery completed successfully" : "Recovery failed"
  };

  return state;
}

async function interruptRecoveryTracking(options = {}) {
  const { autoRollback = true } = options;
  
  isInterrupted = true;
  
  const state = {
    status: RECOVERY_STATES.INTERRUPTED,
    interruptedAt: new Date().toISOString(),
    progress: currentProgress,
    autoRollback
  };

  await saveRecoveryState(state);
  
  currentProgress = {
    phase: "interrupted",
    percent: currentProgress?.percent || 0,
    message: "Recovery was interrupted"
  };

  return state;
}

function startTransaction(trackingState) {
  activeTransaction = {
    id: createId("tx"),
    startedAt: new Date().toISOString(),
    backupResult: trackingState?.backupResult || null,
    processedSessions: [],
    processedLeaderboardEntries: [],
    status: "active"
  };
  return activeTransaction;
}

function getActiveTransaction() {
  return activeTransaction;
}

function recordProcessedSession(sessionId, action) {
  if (!activeTransaction) return null;
  
  const record = {
    sessionId,
    action,
    processedAt: new Date().toISOString()
  };
  activeTransaction.processedSessions.push(record);
  return record;
}

function clearTransaction() {
  activeTransaction = null;
}

async function rollbackFromBackup(backupResult, trigger = ROLLBACK_TRIGGERS.MANUAL) {
  if (!backupResult || !backupResult.backupId) {
    return {
      success: false,
      error: "No backup available for rollback",
      trigger
    };
  }

  const state = {
    status: RECOVERY_STATES.ROLLING_BACK,
    rollbackStartedAt: new Date().toISOString(),
    backupId: backupResult.backupId,
    trigger
  };
  await saveRecoveryState(state);

  currentProgress = {
    phase: "rolling_back",
    percent: 50,
    message: "Rolling back to pre-recovery state..."
  };

  const restoreResult = await restoreFromBackup(backupResult.backupId);

  const finalState = {
    status: restoreResult.success ? RECOVERY_STATES.ROLLED_BACK : RECOVERY_STATES.FAILED,
    rollbackCompletedAt: new Date().toISOString(),
    backupId: backupResult.backupId,
    trigger,
    restoreResult
  };
  await saveRecoveryState(finalState);

  currentProgress = {
    phase: restoreResult.success ? "rolled_back" : "rollback_failed",
    percent: 100,
    message: restoreResult.success ? "Rollback completed successfully" : "Rollback failed"
  };

  clearTransaction();

  return {
    success: restoreResult.success,
    backupId: backupResult.backupId,
    trigger,
    restoredItems: restoreResult.restoredItems || 0,
    error: restoreResult.error
  };
}

function canRollback(trackingState) {
  if (!trackingState) return false;
  if (trackingState.dryRun) return false;
  if (!trackingState.backupResult || !trackingState.backupResult.success) return false;
  if (!trackingState.backupResult.backupId) return false;
  return true;
}

async function validateRecoveryConsistency(options = {}) {
  const { sessionIds = [], eventSessionMap = null } = options;
  
  const issues = [];
  
  for (const sessionId of sessionIds) {
    try {
      const session = await readJson(path.join(SESSION_DIR, `${sessionId}.json`), null);
      if (!session) {
        issues.push({
          type: "missing_session",
          sessionId,
          message: "Session file missing after recovery"
        });
        continue;
      }
      
      if (eventSessionMap && eventSessionMap[sessionId]) {
        const expectedEvents = eventSessionMap[sessionId].events;
        if (session.events.length !== expectedEvents.length) {
          issues.push({
            type: "event_count_mismatch",
            sessionId,
            expected: expectedEvents.length,
            actual: session.events.length,
            message: "Event count mismatch between log and session"
          });
        }
      }
    } catch (error) {
      issues.push({
        type: "validation_error",
        sessionId,
        error: error.message,
        message: "Error validating session"
      });
    }
  }
  
  return {
    valid: issues.length === 0,
    issues,
    checkedCount: sessionIds.length,
    issueCount: issues.length
  };
}

module.exports = {
  RECOVERY_STATES,
  ROLLBACK_TRIGGERS,
  generateTimestamp,
  ensureRecoveryDirs,
  createBackup: createBackupFn,
  listBackups,
  restoreFromBackup,
  rollbackFromBackup,
  canRollback,
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
  startTransaction,
  getActiveTransaction,
  recordProcessedSession,
  clearTransaction,
  validateRecoveryConsistency
};
