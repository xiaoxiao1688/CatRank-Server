const path = require("path");
const fsp = require("fs/promises");

const { ensureDir, readJson, writeJsonAtomic } = require("../utils/file-store");
const { createId } = require("../utils/id");

const OPERATION_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  INTERRUPTED: "interrupted",
  COMPLETED: "completed",
  FAILED: "failed",
  ROLLING_BACK: "rolling_back",
  ROLLED_BACK: "rolled_back"
};

function createOperationManager(options) {
  const {
    operationName,
    backupDir,
    reportsDir,
    stateFile,
    tempDir,
    transactionModeEnabled = true,
    trackedResources = [],
    resolveManifestItem = null
  } = options;

  const resources = trackedResources.map((resource) => ({
    ...resource,
    backupPath: resource.backupPath || resource.key
  }));
  const resourcesByKey = new Map(resources.map((resource) => [resource.key, resource]));

  let currentState = null;
  let currentProgress = null;
  let interrupted = false;
  let activeTransaction = null;

  function generateTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  async function pathExists(targetPath) {
    try {
      await fsp.access(targetPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function copyDirectory(sourceDir, targetDir) {
    await ensureDir(targetDir);
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, targetPath);
        continue;
      }

      await ensureDir(path.dirname(targetPath));
      await fsp.copyFile(sourcePath, targetPath);
    }
  }

  async function removePath(targetPath) {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }

  function buildBackupStatePath(backupId) {
    return path.join(backupDir, backupId);
  }

  async function ensureOperationDirs() {
    await ensureDir(backupDir);
    await ensureDir(reportsDir);
    await ensureDir(tempDir);
  }

  async function snapshotResource(backupPath, resource, manifest) {
    const exists = await pathExists(resource.targetPath);
    const item = {
      key: resource.key,
      resourceType: resource.type,
      path: resource.backupPath,
      targetPath: resource.targetPath,
      exists
    };

    if (exists) {
      const resourceBackupPath = path.join(backupPath, resource.backupPath);
      if (resource.type === "directory") {
        await copyDirectory(resource.targetPath, resourceBackupPath);
      } else {
        await ensureDir(path.dirname(resourceBackupPath));
        await fsp.copyFile(resource.targetPath, resourceBackupPath);
      }
    }

    manifest.items.push(item);
  }

  async function createBackup(label = `pre-${operationName}`) {
    await ensureOperationDirs();

    const timestamp = generateTimestamp();
    const backupId = `backup_${timestamp}_${createId("bkp")}`;
    const backupPath = buildBackupStatePath(backupId);

    await ensureDir(backupPath);

    const manifest = {
      id: backupId,
      operation: operationName,
      timestamp: new Date().toISOString(),
      label,
      items: []
    };

    try {
      for (const resource of resources) {
        await snapshotResource(backupPath, resource, manifest);
      }

      const manifestPath = path.join(backupPath, "manifest.json");
      await writeJsonAtomic(manifestPath, manifest);

      return {
        success: true,
        backupId,
        backupPath,
        manifest
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
    await ensureOperationDirs();

    try {
      const entries = await fsp.readdir(backupDir, { withFileTypes: true });
      const backups = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("backup_")) {
          continue;
        }

        const manifestPath = path.join(backupDir, entry.name, "manifest.json");
        try {
          const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
          backups.push(manifest);
        } catch {
          backups.push({
            id: entry.name,
            timestamp: null,
            label: "unknown",
            error: "Failed to read manifest"
          });
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

  function resolveTrackedManifestItem(item) {
    if (item && item.targetPath && item.resourceType) {
      return {
        targetPath: item.targetPath,
        resourceType: item.resourceType,
        relativeBackupPath: item.path
      };
    }

    if (item && item.key && resourcesByKey.has(item.key)) {
      const resource = resourcesByKey.get(item.key);
      return {
        targetPath: resource.targetPath,
        resourceType: resource.type,
        relativeBackupPath: item.path || resource.backupPath
      };
    }

    if (typeof resolveManifestItem === "function") {
      return resolveManifestItem(item);
    }

    return null;
  }

  async function restoreManifestItem(backupPath, item) {
    const resolved = resolveTrackedManifestItem(item);
    if (!resolved || !resolved.targetPath || !resolved.resourceType) {
      throw new Error(`Cannot restore manifest item for ${operationName}`);
    }

    const { targetPath, resourceType, relativeBackupPath } = resolved;
    const itemExists = Object.prototype.hasOwnProperty.call(item, "exists") ? item.exists : true;

    if (!itemExists) {
      await removePath(targetPath);
      return;
    }

    const sourcePath = path.join(backupPath, relativeBackupPath);

    if (resourceType === "directory") {
      await removePath(targetPath);
      await copyDirectory(sourcePath, targetPath);
      return;
    }

    await ensureDir(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  }

  async function restoreFromBackup(backupId) {
    await ensureOperationDirs();

    const backupPath = buildBackupStatePath(backupId);
    const manifestPath = path.join(backupPath, "manifest.json");

    try {
      await fsp.access(backupPath);
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
      const items = Array.isArray(manifest.items) ? manifest.items : [];

      for (const item of items) {
        await restoreManifestItem(backupPath, item);
      }

      return {
        success: true,
        backupId,
        restoredItems: items.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        backupId
      };
    }
  }

  async function saveOperationReport(report) {
    await ensureOperationDirs();

    const timestamp = generateTimestamp();
    const reportId = `report_${timestamp}`;
    const reportPath = path.join(reportsDir, `${reportId}.json`);
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

  async function listOperationReports() {
    await ensureOperationDirs();

    try {
      const files = await fsp.readdir(reportsDir);
      const reports = [];

      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }

        try {
          const filePath = path.join(reportsDir, file);
          const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));
          reports.push({
            id: data.id || file.replace(".json", ""),
            timestamp: data.timestamp,
            dryRun: data.dryRun,
            summary: data.summary
          });
        } catch {
          reports.push({
            id: file.replace(".json", ""),
            error: "Failed to read report"
          });
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

  async function getOperationReport(reportId) {
    await ensureOperationDirs();

    const reportPath = path.join(reportsDir, `${reportId}.json`);

    try {
      const report = JSON.parse(await fsp.readFile(reportPath, "utf-8"));
      return {
        success: true,
        report
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        report: null
      };
    }
  }

  async function saveOperationState(state) {
    await ensureOperationDirs();
    await writeJsonAtomic(stateFile, state);
    currentState = { ...state };
  }

  async function loadOperationState() {
    await ensureOperationDirs();

    try {
      const state = await readJson(stateFile, null);
      currentState = state;
      return state;
    } catch {
      currentState = null;
      return null;
    }
  }

  function getCurrentOperationState() {
    return currentState;
  }

  function setInterrupted(flag = true) {
    interrupted = flag;
  }

  function isInterrupted() {
    return interrupted;
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

  async function startOperationTracking(options = {}) {
    const { dryRun = true, createBackup: shouldCreateBackup = true, metadata = {} } = options;

    interrupted = false;
    currentProgress = {
      phase: "initializing",
      percent: 0,
      message: `Initializing ${operationName} process...`
    };

    let backupResult = null;
    if (shouldCreateBackup && !dryRun) {
      currentProgress.phase = "backing_up";
      currentProgress.message = `Creating backup before ${operationName}...`;
      backupResult = await createBackup(`pre-${operationName}`);
    }

    const state = {
      status: OPERATION_STATES.RUNNING,
      dryRun,
      createBackup: shouldCreateBackup,
      backupResult,
      startedAt: new Date().toISOString(),
      progress: currentProgress,
      ...metadata
    };

    await saveOperationState(state);
    return state;
  }

  function getFinalStatus(success, explicitStatus, report) {
    if (explicitStatus) {
      return explicitStatus;
    }

    if (report?.rollbackResult?.rolledBack) {
      return OPERATION_STATES.ROLLED_BACK;
    }

    return success ? OPERATION_STATES.COMPLETED : OPERATION_STATES.FAILED;
  }

  function buildFinalProgress(status, message) {
    if (status === OPERATION_STATES.ROLLED_BACK) {
      return {
        phase: "rolled_back",
        percent: 100,
        message: message || `${operationName} rolled back`
      };
    }

    if (status === OPERATION_STATES.FAILED) {
      return {
        phase: "failed",
        percent: 100,
        message: message || `${operationName} failed`
      };
    }

    return {
      phase: "completed",
      percent: 100,
      message: message || `${operationName} completed successfully`
    };
  }

  async function completeOperationTracking(report, options = {}) {
    const { success = true, status = null, message = null, persistReport = !report?.dryRun } = options;
    const finalStatus = getFinalStatus(success, status, report);
    const progress = buildFinalProgress(finalStatus, message);

    const state = {
      status: finalStatus,
      completedAt: new Date().toISOString(),
      reportId: null,
      transactionId: report?.transactionId || activeTransaction?.transactionId || null,
      progress
    };

    if (report && persistReport) {
      const saveResult = await saveOperationReport(report);
      if (saveResult.success) {
        state.reportId = saveResult.reportId;
      }
    }

    await saveOperationState(state);
    currentProgress = progress;
    return state;
  }

  async function interruptOperationTracking() {
    interrupted = true;

    const progress = {
      phase: "interrupted",
      percent: currentProgress?.percent || 0,
      message: `${operationName} was interrupted`
    };

    const state = {
      status: OPERATION_STATES.INTERRUPTED,
      interruptedAt: new Date().toISOString(),
      transactionId: activeTransaction?.transactionId || null,
      progress
    };

    await saveOperationState(state);
    currentProgress = progress;
    return state;
  }

  async function createTransaction() {
    await ensureOperationDirs();

    const transaction = {
      transactionId: `txn_${generateTimestamp()}_${createId("txn")}`,
      createdAt: new Date().toISOString(),
      transactionMode: transactionModeEnabled
    };

    activeTransaction = transaction;
    return transaction;
  }

  async function rollbackTransaction(transactionId, backupResult = null) {
    if (!transactionModeEnabled) {
      return { success: true, skipped: true, reason: "transaction_mode_disabled" };
    }

    const rollingBackProgress = {
      phase: "rolling_back",
      percent: currentProgress?.percent || 0,
      message: `Rolling back ${operationName}...`
    };

    await saveOperationState({
      status: OPERATION_STATES.ROLLING_BACK,
      rollingBackAt: new Date().toISOString(),
      transactionId,
      backupResult,
      progress: rollingBackProgress
    });
    currentProgress = rollingBackProgress;

    if (!backupResult || !backupResult.success || !backupResult.backupId) {
      const skippedResult = {
        success: true,
        transactionId,
        rolledBack: false,
        skipped: true,
        reason: "no_backup_available"
      };

      await saveOperationState({
        status: OPERATION_STATES.FAILED,
        failedAt: new Date().toISOString(),
        transactionId,
        progress: rollingBackProgress,
        rollbackResult: skippedResult
      });

      return skippedResult;
    }

    try {
      const restoreResult = await restoreFromBackup(backupResult.backupId);
      if (!restoreResult.success) {
        throw new Error(`Failed to restore from backup: ${restoreResult.error}`);
      }

      const rolledBackProgress = {
        phase: "rolled_back",
        percent: 100,
        message: `${operationName} rolled back successfully`
      };

      await saveOperationState({
        status: OPERATION_STATES.ROLLED_BACK,
        rolledBackAt: new Date().toISOString(),
        transactionId,
        restoredFromBackup: backupResult.backupId,
        progress: rolledBackProgress
      });
      currentProgress = rolledBackProgress;

      return {
        success: true,
        transactionId,
        rolledBack: true,
        restoredFromBackup: backupResult.backupId
      };
    } catch (error) {
      const failedProgress = {
        phase: "failed",
        percent: currentProgress?.percent || 0,
        message: `${operationName} rollback failed`
      };

      await saveOperationState({
        status: OPERATION_STATES.FAILED,
        failedAt: new Date().toISOString(),
        transactionId,
        rollbackError: error.message,
        progress: failedProgress
      });
      currentProgress = failedProgress;

      return {
        success: false,
        transactionId,
        rolledBack: false,
        error: error.message
      };
    }
  }

  function getActiveTransactionId() {
    return activeTransaction?.transactionId || null;
  }

  function clearActiveTransaction() {
    activeTransaction = null;
  }

  async function getTransactionMode() {
    return {
      enabled: transactionModeEnabled,
      tempDir
    };
  }

  return {
    OPERATION_STATES,
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
  };
}

module.exports = {
  OPERATION_STATES,
  createOperationManager
};
