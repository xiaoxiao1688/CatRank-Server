const express = require("express");
const { z } = require("zod");
const {
  EXPORT_IMPORT_STATES,
  EXPORT_OPERATION_TYPE,
  IMPORT_OPERATION_TYPE,
  EXPORT_FORMAT_VERSION,
  listExports,
  getExportInfo,
  deleteExport,
  listImports,
  runExportOperation,
  runImportOperation,
  getExportOperation,
  getImportOperation,
  listActiveExportOperations,
  listActiveImportOperations,
  cancelExportOperation,
  cancelImportOperation,
  listExportHistory,
  listImportHistory,
  getExportHistory,
  getImportHistory,
  readExportEvents,
  readImportEvents,
  onExportEvent,
  onImportEvent,
  getExportState,
  getImportState,
  loadExportState,
  loadImportState,
  getExportProgress,
  getImportProgress,
  listImportBackups,
  restoreFromImportBackup
} = require("../services/export-import-manager");
const { requireRecoveryAuth } = require("../middleware/recovery-auth");
const { HttpError } = require("../utils/http-error");

const createExportSchema = z.object({
  includeSessions: z.boolean().optional().default(true),
  includeLeaderboard: z.boolean().optional().default(true),
  includeEventLog: z.boolean().optional().default(true),
  compress: z.boolean().optional().default(true),
  dryRun: z.boolean().optional().default(false),
  metadata: z.object({}).optional().default({})
});

const createImportSchema = z.object({
  source: z.string().min(1),
  importSessions: z.boolean().optional().default(true),
  importLeaderboard: z.boolean().optional().default(true),
  importEventLog: z.boolean().optional().default(true),
  mergeStrategy: z.enum(["skip_existing", "overwrite", "merge"]).optional().default("skip_existing"),
  dryRun: z.boolean().optional().default(true),
  ignoreValidationErrors: z.boolean().optional().default(false),
  metadata: z.object({}).optional().default({})
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

function createExportImportRouter() {
  const router = express.Router();

  router.get("/status", asyncHandler(async (_req, res) => {
    const exportState = getExportState() || await loadExportState();
    const importState = getImportState() || await loadImportState();

    res.json({
      ok: true,
      export: {
        state: exportState || { status: EXPORT_IMPORT_STATES.IDLE },
        progress: getExportProgress()
      },
      import: {
        state: importState || { status: EXPORT_IMPORT_STATES.IDLE },
        progress: getImportProgress()
      },
      availableStates: Object.values(EXPORT_IMPORT_STATES),
      exportFormatVersion: EXPORT_FORMAT_VERSION
    });
  }));

  router.get("/config", asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      exportFormatVersion: EXPORT_FORMAT_VERSION,
      supportedMergeStrategies: ["skip_existing", "overwrite", "merge"],
      availableStates: Object.values(EXPORT_IMPORT_STATES)
    });
  }));

  router.get("/operations", asyncHandler(async (_req, res) => {
    const exportOps = listActiveExportOperations();
    const importOps = listActiveImportOperations();

    res.json({
      ok: true,
      operations: {
        exports: exportOps,
        imports: importOps
      },
      counts: {
        exports: exportOps.length,
        imports: importOps.length
      }
    });
  }));

  router.get("/operations/export/:operationId", asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const operation = getExportOperation(operationId);

    if (!operation) {
      const historyResult = await getExportHistory(operationId);
      if (historyResult.success && historyResult.operation) {
        return res.json({
          ok: true,
          operation: historyResult.operation,
          fromHistory: true
        });
      }

      throw new HttpError(404, "Export operation not found", { operationId });
    }

    res.json({
      ok: true,
      operation
    });
  }));

  router.get("/operations/import/:operationId", asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const operation = getImportOperation(operationId);

    if (!operation) {
      const historyResult = await getImportHistory(operationId);
      if (historyResult.success && historyResult.operation) {
        return res.json({
          ok: true,
          operation: historyResult.operation,
          fromHistory: true
        });
      }

      throw new HttpError(404, "Import operation not found", { operationId });
    }

    res.json({
      ok: true,
      operation
    });
  }));

  router.post("/operations/export/:operationId/cancel", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const result = await cancelExportOperation(operationId);

    if (!result.success) {
      throw new HttpError(409, `Failed to cancel export: ${result.reason}`, { operationId });
    }

    res.json({
      ok: true,
      cancelled: true,
      operation: result.operation
    });
  }));

  router.post("/operations/import/:operationId/cancel", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { operationId } = req.params;
    const result = await cancelImportOperation(operationId);

    if (!result.success) {
      throw new HttpError(409, `Failed to cancel import: ${result.reason}`, { operationId });
    }

    res.json({
      ok: true,
      cancelled: true,
      operation: result.operation
    });
  }));

  router.get("/history/exports", asyncHandler(async (req, res) => {
    const params = listHistorySchema.parse(req.query);
    const result = await listExportHistory(params);

    if (!result.success) {
      throw new HttpError(500, `Failed to list export history: ${result.error}`);
    }

    res.json({
      ok: true,
      operations: result.operations,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/history/imports", asyncHandler(async (req, res) => {
    const params = listHistorySchema.parse(req.query);
    const result = await listImportHistory(params);

    if (!result.success) {
      throw new HttpError(500, `Failed to list import history: ${result.error}`);
    }

    res.json({
      ok: true,
      operations: result.operations,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/events/exports", asyncHandler(async (req, res) => {
    const params = listEventsSchema.parse(req.query);
    const result = await readExportEvents(params);

    if (!result.success) {
      throw new HttpError(500, `Failed to read export events: ${result.error}`);
    }

    res.json({
      ok: true,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/events/imports", asyncHandler(async (req, res) => {
    const params = listEventsSchema.parse(req.query);
    const result = await readImportEvents(params);

    if (!result.success) {
      throw new HttpError(500, `Failed to read import events: ${result.error}`);
    }

    res.json({
      ok: true,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/exports", asyncHandler(async (_req, res) => {
    const result = await listExports();

    res.json({
      ok: result.success,
      exports: result.exports,
      count: result.count,
      error: result.error || null
    });
  }));

  router.get("/exports/:exportId", asyncHandler(async (req, res) => {
    const { exportId } = req.params;
    const result = await getExportInfo(exportId);

    if (!result.success) {
      throw new HttpError(404, "Export not found", { exportId });
    }

    res.json({
      ok: true,
      export: result
    });
  }));

  router.delete("/exports/:exportId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { exportId } = req.params;
    const result = await deleteExport(exportId);

    if (!result.success) {
      throw new HttpError(404, "Export not found", { exportId });
    }

    res.json({
      ok: true,
      deleted: true,
      exportId
    });
  }));

  router.post("/export", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const currentExportState = getExportState();
    if (currentExportState && currentExportState.status === EXPORT_IMPORT_STATES.RUNNING) {
      throw new HttpError(409, "Export is already running", {
        currentState: currentExportState.status
      });
    }

    const body = createExportSchema.parse(req.body || {});

    const progressUpdates = [];
    const unregisterListener = onExportEvent("operation.progress", (event) => {
      progressUpdates.push({
        ...event.data,
        timestamp: event.timestamp
      });
    });

    try {
      const result = await runExportOperation({
        dryRun: body.dryRun,
        metadata: {
          ...body.metadata,
          includeSessions: body.includeSessions,
          includeLeaderboard: body.includeLeaderboard,
          includeEventLog: body.includeEventLog,
          compress: body.compress
        }
      });

      res.json({
        ok: result.success,
        dryRun: body.dryRun,
        operationId: result.operation?.id,
        result: result.result || null,
        progressUpdates: progressUpdates.slice(-15)
      });
    } finally {
      unregisterListener();
    }
  }));

  router.get("/imports", asyncHandler(async (_req, res) => {
    const result = await listImports();

    res.json({
      ok: result.success,
      imports: result.imports,
      count: result.count,
      error: result.error || null
    });
  }));

  router.post("/import/validate", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const body = createImportSchema.partial().parse(req.body || {});

    if (!body.source) {
      throw new HttpError(400, "Import source is required");
    }

    const { extractImportPackage, validateImportPackage } = require("../services/export-import-manager");

    try {
      const extractResult = await extractImportPackage(body.source);
      const validation = await validateImportPackage(
        extractResult.extractDir,
        extractResult.manifest,
        {
          validateSessions: body.importSessions !== false,
          validateLeaderboard: body.importLeaderboard !== false,
          validateEventLog: body.importEventLog !== false
        }
      );

      const fsp = require("fs/promises");
      await fsp.rm(extractResult.extractDir, { recursive: true, force: true });

      res.json({
        ok: validation.valid,
        valid: validation.valid,
        manifest: extractResult.manifest,
        issues: validation.issues,
        warnings: validation.warnings
      });
    } catch (error) {
      throw new HttpError(400, `Validation failed: ${error.message}`);
    }
  }));

  router.post("/import", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const currentImportState = getImportState();
    if (currentImportState && currentImportState.status === EXPORT_IMPORT_STATES.RUNNING) {
      throw new HttpError(409, "Import is already running", {
        currentState: currentImportState.status
      });
    }

    const body = createImportSchema.parse(req.body || {});

    const progressUpdates = [];
    const unregisterListener = onImportEvent("operation.progress", (event) => {
      progressUpdates.push({
        ...event.data,
        timestamp: event.timestamp
      });
    });

    try {
      const result = await runImportOperation({
        dryRun: body.dryRun,
        metadata: {
          ...body.metadata,
          source: body.source,
          importSessions: body.importSessions,
          importLeaderboard: body.importLeaderboard,
          importEventLog: body.importEventLog,
          mergeStrategy: body.mergeStrategy,
          ignoreValidationErrors: body.ignoreValidationErrors
        }
      });

      const importResult = result.result || {};

      res.json({
        ok: result.success,
        dryRun: body.dryRun,
        operationId: result.operation?.id,
        result: {
          sessions: importResult.sessions,
          leaderboard: importResult.leaderboard,
          events: importResult.events,
          warnings: importResult.warnings || [],
          validation: importResult.validation
        },
        progressUpdates: progressUpdates.slice(-15)
      });
    } finally {
      unregisterListener();
    }
  }));

  router.get("/backups/imports", asyncHandler(async (_req, res) => {
    const result = await listImportBackups();

    res.json({
      ok: result.success,
      backups: result.backups,
      error: result.error || null
    });
  }));

  router.post("/backups/imports/:backupId/restore", requireRecoveryAuth, asyncHandler(async (req, res) => {
    const { backupId } = req.params;

    const currentImportState = getImportState();
    if (currentImportState && currentImportState.status === EXPORT_IMPORT_STATES.RUNNING) {
      throw new HttpError(409, "Cannot restore backup while import is running");
    }

    const result = await restoreFromImportBackup(backupId);

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
  createExportImportRouter
};
