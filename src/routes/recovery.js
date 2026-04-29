const express = require("express");
const { z } = require("zod");
const {
  createRecoveryService,
  runRecoveryWithOptions
} = require("../services/recovery-service");
const {
  listBackups,
  restoreFromBackup,
  listQuarantinedItems,
  listRecoveryReports,
  getRecoveryReport,
  loadRecoveryState,
  getCurrentRecoveryState,
  interruptRecoveryTracking,
  getCurrentProgress,
  getTransactionMode,
  RECOVERY_STATES,
  runRecoveryOperation,
  getRecoveryOperation,
  listActiveRecoveryOperations,
  cancelRecoveryOperation,
  listRecoveryHistory,
  getRecoveryHistory,
  readRecoveryEvents,
  onRecoveryEvent,
  listRegisteredOperations
} = require("../services/recovery-manager");
const { requireRecoveryAuth } = require("../middleware/recovery-auth");
const { HttpError } = require("../utils/http-error");

const runRecoverySchema = z.object({
  dryRun: z.boolean().optional().default(true),
  createBackup: z.boolean().optional().default(true),
  quarantineCorrupted: z.boolean().optional().default(true),
  enableTransaction: z.boolean().optional().default(true),
  logFilePath: z.string().optional().nullable()
});

const listHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  status: z.string().optional(),
  type: z.string().optional()
});

const listEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  operationId: z.string().optional(),
  type: z.string().optional()
});

function createRecoveryRouter() {
  const router = express.Router();

  router.get("/status", asyncHandler(async (_req, res) => {
    const state = getCurrentRecoveryState() || await loadRecoveryState();
    
    res.json({
      ok: true,
      state: state || { status: RECOVERY_STATES.IDLE },
      progress: getCurrentProgress()
    });
  }));

  router.get("/progress", asyncHandler(async (_req, res) => {
    const progress = getCurrentProgress();
    const state = getCurrentRecoveryState();
    
    res.json({
      ok: true,
      progress: progress || null,
      state: state ? state.status : RECOVERY_STATES.IDLE
    });
  }));

  router.get("/config", asyncHandler(async (_req, res) => {
    const txnMode = await getTransactionMode();
    const registeredOps = listRegisteredOperations();
    
    res.json({
      ok: true,
      transactionMode: txnMode.enabled,
      tempDir: txnMode.tempDir,
      availableStates: Object.values(RECOVERY_STATES),
      registeredOperations: registeredOps
    });
  }));

  router.get("/operations", asyncHandler(async (_req, res) => {
    const activeOps = listActiveRecoveryOperations();
    
    res.json({
      ok: true,
      operations: activeOps,
      count: activeOps.length
    });
  }));

  router.get("/operations/:operationId", asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const operation = getRecoveryOperation(operationId);
    
    if (!operation) {
      const historyResult = await getRecoveryHistory(operationId);
      if (historyResult.success && historyResult.operation) {
        return res.json({
          ok: true,
          operation: historyResult.operation,
          fromHistory: true
        });
      }
      
      throw new HttpError(404, "Operation not found", { operationId });
    }

    res.json({
      ok: true,
      operation
    });
  }));

  router.post("/operations/:operationId/cancel", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const result = await cancelRecoveryOperation(operationId);
    
    if (!result.success) {
      throw new HttpError(409, `Failed to cancel operation: ${result.reason}`, { operationId });
    }

    res.json({
      ok: true,
      cancelled: true,
      operation: result.operation
    });
  }));

  router.get("/history", asyncHandler(async (req, res) => {
    const params = listHistorySchema.parse(req.query);
    const result = await listRecoveryHistory(params);
    
    if (!result.success) {
      throw new HttpError(500, `Failed to list history: ${result.error}`);
    }

    res.json({
      ok: true,
      operations: result.operations,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/history/:operationId", asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const result = await getRecoveryHistory(operationId);
    
    if (!result.success || !result.operation) {
      throw new HttpError(404, "Operation history not found", { operationId });
    }

    res.json({
      ok: true,
      operation: result.operation
    });
  }));

  router.get("/events", asyncHandler(async (req, res) => {
    const params = listEventsSchema.parse(req.query);
    const result = await readRecoveryEvents(params);
    
    if (!result.success) {
      throw new HttpError(500, `Failed to read events: ${result.error}`);
    }

    res.json({
      ok: true,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.post("/run", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const currentState = getCurrentRecoveryState();
    if (currentState && currentState.status === RECOVERY_STATES.RUNNING) {
      throw new HttpError(409, "Recovery is already running", {
        currentState: currentState.status
      });
    }

    const body = runRecoverySchema.parse(req.body || {});
    
    const progressUpdates = [];
    
    const unregisterListener = onRecoveryEvent("operation.progress", (event) => {
      progressUpdates.push({
        ...event.data,
        timestamp: event.timestamp
      });
    });

    try {
      const result = await runRecoveryOperation({
        dryRun: body.dryRun,
        createBackup: body.createBackup,
        quarantineCorrupted: body.quarantineCorrupted,
        enableTransaction: body.enableTransaction,
        logFilePath: body.logFilePath || null
      });

      const report = result.result || {};

      res.json({
        ok: result.success,
        dryRun: body.dryRun,
        wasInterrupted: report.wasInterrupted || false,
        rolledBack: report.rollbackResult?.rolledBack || false,
        operationId: result.operation?.id,
        report: {
          id: report.id || null,
          transactionId: report.transactionId || null,
          timestamp: report.timestamp,
          summary: report.summary,
          success: report.success,
          validation: report.validation || null,
          rollbackResult: report.rollbackResult || null
        },
        progressUpdates: progressUpdates.slice(-15)
      });
    } finally {
      unregisterListener();
    }
  }));

  router.post("/interrupt", requireRecoveryAuth, asyncHandler(async (_req, res) => {
    const currentState = getCurrentRecoveryState();
    
    if (!currentState || currentState.status !== RECOVERY_STATES.RUNNING) {
      throw new HttpError(409, "No recovery is currently running", {
        currentState: currentState ? currentState.status : RECOVERY_STATES.IDLE
      });
    }

    const result = await interruptRecoveryTracking();
    
    res.json({
      ok: true,
      interrupted: true,
      state: result
    });
  }));

  router.get("/backups", asyncHandler(async (_req, res) => {
    const result = await listBackups();
    
    res.json({
      ok: result.success,
      backups: result.backups,
      error: result.error || null
    });
  }));

  router.post("/backups/:backupId/restore", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { backupId } = req.params;
    
    const currentState = getCurrentRecoveryState();
    if (currentState && currentState.status === RECOVERY_STATES.RUNNING) {
      throw new HttpError(409, "Cannot restore backup while recovery is running");
    }

    const result = await restoreFromBackup(backupId);
    
    if (!result.success) {
      throw new HttpError(404, `Failed to restore backup: ${result.error}`, {
        backupId
      });
    }

    res.json({
      ok: true,
      backupId: result.backupId,
      restoredItems: result.restoredItems
    });
  }));

  router.get("/quarantine", asyncHandler(async (_req, res) => {
    const result = await listQuarantinedItems();
    
    res.json({
      ok: result.success,
      items: result.items,
      error: result.error || null
    });
  }));

  router.get("/reports", asyncHandler(async (_req, res) => {
    const result = await listRecoveryReports();
    
    res.json({
      ok: result.success,
      reports: result.reports,
      error: result.error || null
    });
  }));

  router.get("/reports/:reportId", asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const result = await getRecoveryReport(reportId);
    
    if (!result.success || !result.report) {
      throw new HttpError(404, "Recovery report not found", {
        reportId
      });
    }

    res.json({
      ok: true,
      report: result.report
    });
  }));

  router.get("/states", asyncHandler(async (_req, res) => {
    const state = await loadRecoveryState();
    
    res.json({
      ok: true,
      state: state || null,
      availableStates: Object.values(RECOVERY_STATES)
    });
  }));

  return router;
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  createRecoveryRouter
};
