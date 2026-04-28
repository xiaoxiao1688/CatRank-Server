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
  RECOVERY_STATES
} = require("../services/recovery-manager");
const { HttpError } = require("../utils/http-error");

const runRecoverySchema = z.object({
  dryRun: z.boolean().optional().default(true),
  createBackup: z.boolean().optional().default(true),
  quarantineCorrupted: z.boolean().optional().default(true),
  logFilePath: z.string().optional().nullable()
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

  router.post("/run", asyncHandler(async (req, res) => {
    const currentState = getCurrentRecoveryState();
    if (currentState && currentState.status === RECOVERY_STATES.RUNNING) {
      throw new HttpError(409, "Recovery is already running", {
        currentState: currentState.status
      });
    }

    const body = runRecoverySchema.parse(req.body || {});
    
    const progressUpdates = [];
    
    const service = await createRecoveryService({
      dryRun: body.dryRun,
      createBackup: body.createBackup,
      quarantineCorrupted: body.quarantineCorrupted,
      logFilePath: body.logFilePath || null,
      onProgress: (progress) => {
        progressUpdates.push({
          ...progress,
          timestamp: new Date().toISOString()
        });
      }
    });

    const report = await service.runRecovery();

    res.json({
      ok: report.success,
      dryRun: body.dryRun,
      report: {
        id: report.id || null,
        timestamp: report.timestamp,
        summary: report.summary,
        success: report.success
      },
      progressUpdates: progressUpdates.slice(-10)
    });
  }));

  router.post("/interrupt", asyncHandler(async (_req, res) => {
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

  router.post("/backups/:backupId/restore", asyncHandler(async (req, res) => {
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
