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

let currentRecoveryState = null;
let isInterrupted = false;
let currentProgress = null;
let activeTransactionId = null;

function generateTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureRecoveryDirs() {
  await ensureDir(BACKUP_DIR);
  await ensureDir(QUARANTINE_DIR);
  await ensureDir(RECOVERY_REPORTS_DIR);
  await ensureDir(RECOVERY_TEMP_DIR);
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

async function interruptRecoveryTracking() {
  isInterrupted = true;
  
  const state = {
    status: RECOVERY_STATES.INTERRUPTED,
    interruptedAt: new Date().toISOString(),
    progress: currentProgress
  };

  await saveRecoveryState(state);
  
  currentProgress = {
    phase: "interrupted",
    percent: currentProgress?.percent || 0,
    message: "Recovery was interrupted"
  };

  return state;
}

async function createTransaction() {
  await ensureRecoveryDirs();
  
  const timestamp = generateTimestamp();
  const transactionId = `txn_${timestamp}_${createId("txn")}`;
  
  activeTransactionId = transactionId;
  
  return {
    transactionId,
    createdAt: new Date().toISOString(),
    transactionMode: RECOVERY_TRANSACTION_MODE
  };
}

async function rollbackTransaction(transactionId, backupResult = null) {
  if (!RECOVERY_TRANSACTION_MODE) {
    return { success: true, skipped: true, reason: "transaction_mode_disabled" };
  }
  
  currentRecoveryState = {
    status: RECOVERY_STATES.ROLLING_BACK,
    rollingBackAt: new Date().toISOString(),
    transactionId,
    backupResult
  };
  
  await saveRecoveryState(currentRecoveryState);
  
  updateProgress({
    phase: "rolling_back",
    percent: currentProgress?.percent || 0,
    message: "Rolling back recovery..."
  });
  
  try {
    if (backupResult && backupResult.success && backupResult.backupId) {
      const restoreResult = await restoreFromBackup(backupResult.backupId);
      
      if (!restoreResult.success) {
        throw new Error(`Failed to restore from backup: ${restoreResult.error}`);
      }
      
      currentRecoveryState = {
        status: RECOVERY_STATES.ROLLED_BACK,
        rolledBackAt: new Date().toISOString(),
        transactionId,
        restoredFromBackup: backupResult.backupId
      };
      
      await saveRecoveryState(currentRecoveryState);
      
      updateProgress({
        phase: "rolled_back",
        percent: 100,
        message: "Recovery rolled back successfully"
      });
      
      return {
        success: true,
        transactionId,
        rolledBack: true,
        restoredFromBackup: backupResult.backupId
      };
    } else {
      currentRecoveryState = {
        status: RECOVERY_STATES.ROLLED_BACK,
        rolledBackAt: new Date().toISOString(),
        transactionId,
        warning: "No backup available for rollback"
      };
      
      await saveRecoveryState(currentRecoveryState);
      
      return {
        success: true,
        transactionId,
        rolledBack: true,
        warning: "No backup available for rollback"
      };
    }
  } catch (error) {
    currentRecoveryState = {
      status: RECOVERY_STATES.FAILED,
      failedAt: new Date().toISOString(),
      transactionId,
      rollbackError: error.message
    };
    
    await saveRecoveryState(currentRecoveryState);
    
    return {
      success: false,
      transactionId,
      rolledBack: false,
      error: error.message
    };
  }
}

function getActiveTransactionId() {
  return activeTransactionId;
}

function clearActiveTransaction() {
  activeTransactionId = null;
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
  
  if (report.summary.totalSessions !== (report.summary.recovered + report.summary.skipped + report.summary.failed)) {
    issues.push({
      type: "session_count_mismatch",
      message: `Session count mismatch: total=${report.summary.totalSessions}, sum=${report.summary.recovered + report.summary.skipped + report.summary.failed}`
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
      failed: report.summary.failed
    }
  };
}

async function getTransactionMode() {
  return {
    enabled: RECOVERY_TRANSACTION_MODE,
    tempDir: RECOVERY_TEMP_DIR
  };
}

module.exports = {
  RECOVERY_STATES,
  generateTimestamp,
  ensureRecoveryDirs,
  createBackup: createBackupFn,
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
