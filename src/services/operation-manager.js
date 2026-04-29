const path = require("path");
const fsp = require("fs/promises");
const events = require("events");

const { ensureDir, readJson, writeJsonAtomic, appendLine } = require("../utils/file-store");
const { createId } = require("../utils/id");

const OPERATION_STATES = {
  IDLE: "idle",
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  INTERRUPTED: "interrupted",
  COMPLETED: "completed",
  FAILED: "failed",
  ROLLING_BACK: "rolling_back",
  ROLLED_BACK: "rolled_back",
  TIMED_OUT: "timed_out"
};

const OPERATION_EVENT_TYPES = {
  CREATED: "operation.created",
  STARTED: "operation.started",
  PROGRESS: "operation.progress",
  PAUSED: "operation.paused",
  RESUMED: "operation.resumed",
  INTERRUPTED: "operation.interrupted",
  COMPLETED: "operation.completed",
  FAILED: "operation.failed",
  TIMED_OUT: "operation.timed_out",
  ROLLING_BACK: "operation.rolling_back",
  ROLLED_BACK: "operation.rolled_back",
  RETRY_SCHEDULED: "operation.retry_scheduled",
  RETRY_STARTED: "operation.retry_started"
};

const DEFAULT_OPERATION_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000,
  timeoutMs: 300000,
  concurrencyKey: null,
  maxConcurrency: 1,
  autoRollbackOnFailure: true,
  persistEvents: true
};

const operationRegistry = new Map();
const operationEventEmitter = new events.EventEmitter();
const activeOperations = new Map();
const concurrencyQueues = new Map();
const operationTimers = new Map();

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConcurrencyQueue(concurrencyKey) {
  if (!concurrencyQueues.has(concurrencyKey)) {
    concurrencyQueues.set(concurrencyKey, {
      active: 0,
      queue: [],
      maxConcurrency: 1
    });
  }
  return concurrencyQueues.get(concurrencyKey);
}

function createOperationManager(options) {
  const {
    operationName,
    backupDir,
    reportsDir,
    stateFile,
    tempDir,
    historyDir,
    eventLogFile,
    transactionModeEnabled = true,
    trackedResources = [],
    resolveManifestItem = null,
    defaultConfig = {}
  } = options;

  const managerDefaultConfig = { ...DEFAULT_OPERATION_CONFIG, ...defaultConfig };
  const resources = trackedResources.map((resource) => ({
    ...resource,
    backupPath: resource.backupPath || resource.key
  }));
  const resourcesByKey = new Map(resources.map((resource) => [resource.key, resource]));

  let currentState = null;
  let currentProgress = null;
  let interrupted = false;
  let activeTransaction = null;
  let currentOperationId = null;

  function buildBackupStatePath(backupId) {
    return path.join(backupDir, backupId);
  }

  async function ensureOperationDirs() {
    await ensureDir(backupDir);
    await ensureDir(reportsDir);
    await ensureDir(tempDir);
    if (historyDir) await ensureDir(historyDir);
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

  function registerOperation(operationDef) {
    const {
      type,
      handler,
      rollbackHandler = null,
      config = {}
    } = operationDef;

    if (operationRegistry.has(type)) {
      throw new Error(`Operation type '${type}' is already registered`);
    }

    const fullConfig = { ...managerDefaultConfig, ...config };

    operationRegistry.set(type, {
      type,
      handler,
      rollbackHandler,
      config: fullConfig
    });

    return {
      type,
      config: fullConfig
    };
  }

  function getRegisteredOperation(type) {
    return operationRegistry.get(type) || null;
  }

  function listRegisteredOperations() {
    return Array.from(operationRegistry.entries()).map(([type, def]) => ({
      type,
      config: def.config
    }));
  }

  function emitOperationEvent(eventType, operationId, data = {}) {
    const event = {
      id: createId("evt"),
      type: eventType,
      operationId,
      operationType: operationName,
      timestamp: new Date().toISOString(),
      data
    };

    operationEventEmitter.emit(eventType, event);
    operationEventEmitter.emit("*", event);

    if (eventLogFile && managerDefaultConfig.persistEvents) {
      appendLine(eventLogFile, JSON.stringify(event)).catch(() => {});
    }
  }

  function onOperationEvent(eventType, listener) {
    operationEventEmitter.on(eventType, listener);
    return () => operationEventEmitter.off(eventType, listener);
  }

  async function createOperation(type, options = {}) {
    const operationDef = getRegisteredOperation(type);
    if (!operationDef) {
      throw new Error(`Operation type '${type}' is not registered`);
    }

    const operationId = `op_${generateTimestamp()}_${createId("op")}`;
    const config = { ...operationDef.config, ...options.config };

    const operation = {
      id: operationId,
      type,
      status: OPERATION_STATES.PENDING,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      interruptedAt: null,
      timeoutAt: null,
      retries: 0,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      timeoutMs: config.timeoutMs,
      concurrencyKey: config.concurrencyKey || type,
      maxConcurrency: config.maxConcurrency,
      autoRollbackOnFailure: config.autoRollbackOnFailure,
      dryRun: options.dryRun !== false,
      progress: {
        phase: "pending",
        percent: 0,
        message: `Operation ${type} pending execution`
      },
      result: null,
      error: null,
      backupResult: null,
      rollbackResult: null,
      metadata: options.metadata || {}
    };

    currentOperationId = operationId;
    activeOperations.set(operationId, operation);
    emitOperationEvent(OPERATION_EVENT_TYPES.CREATED, operationId, operation);

    if (historyDir) {
      const historyPath = path.join(historyDir, `${operationId}.json`);
      await writeJsonAtomic(historyPath, operation);
    }

    return operation;
  }

  async function updateOperation(operationId, updates) {
    const operation = activeOperations.get(operationId);
    if (!operation) {
      return null;
    }

    Object.assign(operation, updates, {
      updatedAt: new Date().toISOString()
    });

    if (historyDir) {
      const historyPath = path.join(historyDir, `${operationId}.json`);
      await writeJsonAtomic(historyPath, operation).catch(() => {});
    }

    return operation;
  }

  function getOperation(operationId) {
    return activeOperations.get(operationId) || null;
  }

  function listActiveOperations() {
    return Array.from(activeOperations.values());
  }

  async function acquireConcurrencySlot(operation) {
    const concurrencyKey = operation.concurrencyKey;
    const queue = getConcurrencyQueue(concurrencyKey);

    if (operation.maxConcurrency) {
      queue.maxConcurrency = operation.maxConcurrency;
    }

    if (queue.active < queue.maxConcurrency) {
      queue.active++;
      return true;
    }

    return new Promise((resolve) => {
      queue.queue.push(() => {
        queue.active++;
        resolve(true);
      });
    });
  }

  function releaseConcurrencySlot(concurrencyKey) {
    const queue = getConcurrencyQueue(concurrencyKey);
    queue.active--;

    if (queue.queue.length > 0) {
      const next = queue.queue.shift();
      next();
    }
  }

  function setTimeoutForOperation(operation) {
    if (!operation.timeoutMs || operation.timeoutMs <= 0) {
      return;
    }

    const timeoutId = setTimeout(async () => {
      const currentOp = activeOperations.get(operation.id);
      if (!currentOp || currentOp.status !== OPERATION_STATES.RUNNING) {
        return;
      }

      await updateOperation(operation.id, {
        status: OPERATION_STATES.TIMED_OUT,
        timeoutAt: new Date().toISOString(),
        progress: {
          phase: "timed_out",
          percent: currentOp.progress?.percent || 0,
          message: `Operation timed out after ${operation.timeoutMs}ms`
        }
      });

      emitOperationEvent(OPERATION_EVENT_TYPES.TIMED_OUT, operation.id, {
        timeoutMs: operation.timeoutMs
      });

      setInterrupted(true);
    }, operation.timeoutMs);

    operationTimers.set(operation.id, timeoutId);
  }

  function clearTimeoutForOperation(operationId) {
    const timeoutId = operationTimers.get(operationId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      operationTimers.delete(operationId);
    }
  }

  async function executeOperation(operation) {
    const operationDef = getRegisteredOperation(operation.type);
    if (!operationDef) {
      throw new Error(`Operation type '${operation.type}' is not registered`);
    }

    await acquireConcurrencySlot(operation);

    try {
      await updateOperation(operation.id, {
        status: OPERATION_STATES.RUNNING,
        startedAt: new Date().toISOString(),
        progress: {
          phase: "starting",
          percent: 0,
          message: `Starting operation ${operation.type}...`
        }
      });

      emitOperationEvent(OPERATION_EVENT_TYPES.STARTED, operation.id, operation);

      setTimeoutForOperation(operation);

      let backupResult = null;
      if (transactionModeEnabled && operation.autoRollbackOnFailure && !operation.dryRun) {
        await updateOperation(operation.id, {
          progress: {
            phase: "backing_up",
            percent: 5,
            message: "Creating backup before operation..."
          }
        });
        backupResult = await createBackup(`pre-${operation.type}`);
        await updateOperation(operation.id, { backupResult });
      }

      let result = null;
      let lastError = null;

      for (let attempt = 0; attempt <= operation.maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            emitOperationEvent(OPERATION_EVENT_TYPES.RETRY_STARTED, operation.id, {
              attempt,
              maxRetries: operation.maxRetries
            });

            await updateOperation(operation.id, {
              retries: attempt,
              progress: {
                phase: "retrying",
                percent: operation.progress?.percent || 0,
                message: `Retry attempt ${attempt} of ${operation.maxRetries}...`
              }
            });
          }

          result = await operationDef.handler({
            operation,
            progress: (progress) => {
              updateOperation(operation.id, { progress });
              emitOperationEvent(OPERATION_EVENT_TYPES.PROGRESS, operation.id, progress);
            },
            isInterrupted: () => isInterrupted()
          });

          await updateOperation(operation.id, {
            status: OPERATION_STATES.COMPLETED,
            completedAt: new Date().toISOString(),
            result,
            progress: {
              phase: "completed",
              percent: 100,
              message: `Operation ${operation.type} completed successfully`
            }
          });

          emitOperationEvent(OPERATION_EVENT_TYPES.COMPLETED, operation.id, {
            result
          });

          clearTimeoutForOperation(operation.id);
          activeOperations.delete(operation.id);
          releaseConcurrencySlot(operation.concurrencyKey);

          return {
            success: true,
            operation: getOperation(operation.id) || operation,
            result
          };

        } catch (error) {
          lastError = error;

          if (attempt < operation.maxRetries) {
            emitOperationEvent(OPERATION_EVENT_TYPES.RETRY_SCHEDULED, operation.id, {
              attempt: attempt + 1,
              maxRetries: operation.maxRetries,
              delayMs: operation.retryDelayMs
            });

            await delay(operation.retryDelayMs);
          }
        }
      }

      await updateOperation(operation.id, {
        status: OPERATION_STATES.FAILED,
        failedAt: new Date().toISOString(),
        error: {
          message: lastError.message,
          stack: lastError.stack
        },
        progress: {
          phase: "failed",
          percent: operation.progress?.percent || 0,
          message: `Operation failed: ${lastError.message}`
        }
      });

      emitOperationEvent(OPERATION_EVENT_TYPES.FAILED, operation.id, {
        error: lastError.message,
        attempts: operation.retries + 1
      });

      if (operation.autoRollbackOnFailure && operationDef.rollbackHandler && backupResult?.success) {
        await updateOperation(operation.id, {
          status: OPERATION_STATES.ROLLING_BACK,
          progress: {
            phase: "rolling_back",
            percent: operation.progress?.percent || 0,
            message: "Rolling back operation..."
          }
        });

        emitOperationEvent(OPERATION_EVENT_TYPES.ROLLING_BACK, operation.id, {});

        try {
          const rollbackResult = await operationDef.rollbackHandler({
            operation,
            backupResult,
            progress: (progress) => {
              updateOperation(operation.id, { progress });
            }
          });

          await updateOperation(operation.id, {
            status: OPERATION_STATES.ROLLED_BACK,
            rollbackResult,
            progress: {
              phase: "rolled_back",
              percent: 100,
              message: "Operation rolled back successfully"
            }
          });

          emitOperationEvent(OPERATION_EVENT_TYPES.ROLLED_BACK, operation.id, {
            rollbackResult
          });

        } catch (rollbackError) {
          await updateOperation(operation.id, {
            rollbackError: rollbackError.message,
            progress: {
              phase: "rollback_failed",
              percent: operation.progress?.percent || 0,
              message: `Rollback failed: ${rollbackError.message}`
            }
          });
        }
      }

      clearTimeoutForOperation(operation.id);
      activeOperations.delete(operation.id);
      releaseConcurrencySlot(operation.concurrencyKey);

      return {
        success: false,
        operation: getOperation(operation.id) || operation,
        error: lastError
      };

    } catch (error) {
      clearTimeoutForOperation(operation.id);
      activeOperations.delete(operation.id);
      releaseConcurrencySlot(operation.concurrencyKey);

      throw error;
    }
  }

  async function runOperation(type, options = {}) {
    const operation = await createOperation(type, options);
    return executeOperation(operation);
  }

  async function cancelOperation(operationId) {
    const operation = activeOperations.get(operationId);
    if (!operation) {
      return { success: false, reason: "operation_not_found" };
    }

    if (operation.status !== OPERATION_STATES.RUNNING && operation.status !== OPERATION_STATES.PENDING) {
      return { success: false, reason: "operation_not_running" };
    }

    setInterrupted(true);
    await updateOperation(operation.id, {
      status: OPERATION_STATES.INTERRUPTED,
      interruptedAt: new Date().toISOString(),
      progress: {
        phase: "interrupted",
        percent: operation.progress?.percent || 0,
        message: "Operation was interrupted"
      }
    });

    emitOperationEvent(OPERATION_EVENT_TYPES.INTERRUPTED, operation.id, {});
    clearTimeoutForOperation(operation.id);

    return { success: true, operation: getOperation(operationId) };
  }

  async function listOperationHistory(options = {}) {
    const { limit = 50, offset = 0, status = null, type = null } = options;

    if (!historyDir) {
      return {
        success: true,
        operations: [],
        total: 0
      };
    }

    try {
      const files = await fsp.readdir(historyDir);
      const operationFiles = files.filter(f => f.startsWith("op_") && f.endsWith(".json"));

      let operations = [];

      for (const file of operationFiles) {
        try {
          const filePath = path.join(historyDir, file);
          const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));

          if (status && data.status !== status) continue;
          if (type && data.type !== type) continue;

          operations.push(data);
        } catch {
          continue;
        }
      }

      operations.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      const total = operations.length;
      const paginated = operations.slice(offset, offset + limit);

      return {
        success: true,
        operations: paginated,
        total,
        limit,
        offset
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operations: [],
        total: 0
      };
    }
  }

  async function getOperationHistory(operationId) {
    if (!historyDir) {
      return {
        success: false,
        error: "history_dir_not_configured",
        operation: null
      };
    }

    const historyPath = path.join(historyDir, `${operationId}.json`);

    try {
      const operation = JSON.parse(await fsp.readFile(historyPath, "utf-8"));
      return {
        success: true,
        operation
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: null
      };
    }
  }

  async function readOperationEvents(options = {}) {
    const { limit = 100, offset = 0, operationId = null, type = null } = options;

    if (!eventLogFile) {
      return {
        success: true,
        events: [],
        total: 0
      };
    }

    try {
      const content = await fsp.readFile(eventLogFile, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());

      let events = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (operationId && event.operationId !== operationId) continue;
          if (type && event.type !== type) continue;

          events.push(event);
        } catch {
          continue;
        }
      }

      events.sort((a, b) => {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      const total = events.length;
      const paginated = events.slice(offset, offset + limit);

      return {
        success: true,
        events: paginated,
        total,
        limit,
        offset
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        events: [],
        total: 0
      };
    }
  }

  return {
    OPERATION_STATES,
    OPERATION_EVENT_TYPES,
    DEFAULT_OPERATION_CONFIG,
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
    getTransactionMode,
    registerOperation,
    getRegisteredOperation,
    listRegisteredOperations,
    emitOperationEvent,
    onOperationEvent,
    createOperation,
    updateOperation,
    getOperation,
    listActiveOperations,
    executeOperation,
    runOperation,
    cancelOperation,
    listOperationHistory,
    getOperationHistory,
    readOperationEvents,
    acquireConcurrencySlot,
    releaseConcurrencySlot,
    setTimeoutForOperation,
    clearTimeoutForOperation
  };
}

function getGlobalOperationRegistry() {
  return {
    register: (type, handler, config = {}) => {
      if (operationRegistry.has(type)) {
        throw new Error(`Operation type '${type}' is already registered`);
      }
      operationRegistry.set(type, { type, handler, config });
      return { type, config };
    },
    list: () => Array.from(operationRegistry.keys()),
    get: (type) => operationRegistry.get(type)
  };
}

function getGlobalEventEmitter() {
  return operationEventEmitter;
}

module.exports = {
  OPERATION_STATES,
  OPERATION_EVENT_TYPES,
  DEFAULT_OPERATION_CONFIG,
  createOperationManager,
  getGlobalOperationRegistry,
  getGlobalEventEmitter
};
