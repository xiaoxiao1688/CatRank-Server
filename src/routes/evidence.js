const express = require("express");
const { z } = require("zod");
const {
  generateEvidenceId,
  calculateHash,
  calculateParameterDigest,
  getOperationChain,
  listAllOperationChains,
  validateEvidenceChain,
  validateAllEvidenceChains,
  getEvidenceByOperationId,
  exportEvidenceChain,
  replayOperationFromEvidence,
  getEvidenceState,
  verifyParameterConsistency,
  HIGH_RISK_OPERATIONS,
  EVIDENCE_TYPES,
  ensureEvidenceDirs
} = require("../services/evidence-chain-service");
const { EVIDENCE_ENABLED, EVIDENCE_DIR, EVIDENCE_LOG_FILE } = require("../config");
const { readLinesSafe } = require("../utils/file-store");
const { HttpError } = require("../utils/http-error");
const { requireRecoveryAuth } = require("../middleware/recovery-auth");

const listChainsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  operationType: z.string().optional()
});

const replaySchema = z.object({
  dryRun: z.coerce.boolean().optional().default(true)
});

const verifyParametersSchema = z.object({
  evidenceId: z.string(),
  operationId: z.string().optional()
});

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function createEvidenceRouter() {
  const router = express.Router();

  router.get("/status", asyncHandler(async (_req, res) => {
    if (!EVIDENCE_ENABLED) {
      return res.json({
        ok: true,
        enabled: false,
        message: "Evidence chain is disabled"
      });
    }

    await ensureEvidenceDirs();
    const state = await getEvidenceState();

    res.json({
      ok: true,
      enabled: true,
      state,
      highRiskOperations: HIGH_RISK_OPERATIONS,
      evidenceTypes: Object.values(EVIDENCE_TYPES),
      evidenceDir: EVIDENCE_DIR,
      logFile: EVIDENCE_LOG_FILE
    });
  }));

  router.get("/chains", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const params = listChainsSchema.parse(req.query);
    const result = await listAllOperationChains(params);

    res.json({
      ok: true,
      chains: result.chains,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/chains/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const { operationId } = req.params;
    const chain = await getOperationChain(operationId);

    if (!chain) {
      throw new HttpError(404, "Operation chain not found", { operationId });
    }

    const evidenceResult = await getEvidenceByOperationId(operationId);

    res.json({
      ok: true,
      operationId,
      chain,
      evidences: evidenceResult.success ? evidenceResult.evidences : []
    });
  }));

  router.post("/chains/:operationId/validate", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const { operationId } = req.params;
    const chain = await getOperationChain(operationId);

    if (!chain) {
      throw new HttpError(404, "Operation chain not found", { operationId });
    }

    const validation = await validateEvidenceChain(chain);

    res.json({
      ok: true,
      operationId,
      valid: validation.valid,
      issues: validation.issues,
      warnings: validation.warnings,
      details: validation.details
    });
  }));

  router.post("/validate-all", requireRecoveryAuth, asyncHandler(async (_req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const result = await validateAllEvidenceChains();

    res.json({
      ok: true,
      total: result.total,
      valid: result.valid,
      invalid: result.invalid,
      failedChains: result.failedChains
    });
  }));

  router.post("/replay/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const { operationId } = req.params;
    const params = replaySchema.parse(req.body);

    const chain = await getOperationChain(operationId);
    if (!chain) {
      throw new HttpError(404, "Operation chain not found", { operationId });
    }

    const replayResult = await replayOperationFromEvidence(operationId, {
      dryRun: params.dryRun
    });

    res.json({
      ok: replayResult.success,
      operationId,
      operationType: replayResult.operationType,
      dryRun: replayResult.dryRun,
      finalState: replayResult.finalState,
      eventCount: replayResult.eventCount,
      replayLog: replayResult.replayLog,
      message: replayResult.message
    });
  }));

  router.get("/export/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const { operationId } = req.params;

    const exportResult = await exportEvidenceChain(operationId);
    if (!exportResult.success) {
      throw new HttpError(404, exportResult.error || "Failed to export evidence chain", { operationId });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="evidence_${operationId}_${Date.now()}.json"`
    );

    res.json(exportResult.exportData);
  }));

  router.post("/verify-parameters", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const params = verifyParametersSchema.parse(req.body);
    const { evidenceId, operationId } = params;

    let evidence = null;

    if (operationId) {
      const evidenceResult = await getEvidenceByOperationId(operationId);
      if (evidenceResult.success) {
        evidence = evidenceResult.evidences.find(e => e.evidenceId === evidenceId);
      }
    } else {
      const logResult = await readLinesSafe(EVIDENCE_LOG_FILE);
      if (logResult.ok) {
        for (const line of logResult.validLines) {
          try {
            const e = JSON.parse(line.raw);
            if (e.evidenceId === evidenceId) {
              evidence = e;
              break;
            }
          } catch {
            continue;
          }
        }
      }
    }

    if (!evidence) {
      throw new HttpError(404, "Evidence not found", { evidenceId });
    }

    const actualParameters = req.body.actualParameters || {};
    const result = await verifyParameterConsistency(evidence, actualParameters);

    res.json({
      ok: true,
      evidenceId,
      consistent: result.consistent,
      expectedDigest: result.expectedDigest,
      actualDigest: result.actualDigest,
      evidenceParameters: result.evidenceParameters,
      actualParameters: result.actualParameters
    });
  }));

  router.get("/logs", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;

    const result = await readLinesSafe(EVIDENCE_LOG_FILE);
    if (!result.ok) {
      throw new HttpError(500, "Failed to read evidence log");
    }

    const logs = [];
    const start = Math.max(0, result.validLines.length - offset - limit);
    const end = result.validLines.length - offset;

    for (let i = start; i < end && i < result.validLines.length; i++) {
      try {
        const logEntry = JSON.parse(result.validLines[i].raw);
        logs.push(logEntry);
      } catch {
        continue;
      }
    }

    logs.reverse();

    res.json({
      ok: true,
      logs,
      total: result.validLines.length,
      limit,
      offset
    });
  }));

  router.get("/logs/:evidenceId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    if (!EVIDENCE_ENABLED) {
      throw new HttpError(503, "Evidence chain is disabled");
    }

    const { evidenceId } = req.params;
    const result = await readLinesSafe(EVIDENCE_LOG_FILE);

    if (!result.ok) {
      throw new HttpError(500, "Failed to read evidence log");
    }

    let evidence = null;
    for (const line of result.validLines) {
      try {
        const e = JSON.parse(line.raw);
        if (e.evidenceId === evidenceId) {
          evidence = e;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!evidence) {
      throw new HttpError(404, "Evidence not found", { evidenceId });
    }

    res.json({
      ok: true,
      evidence
    });
  }));

  return router;
}

module.exports = {
  createEvidenceRouter
};
