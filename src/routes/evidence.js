const express = require("express");
const { z, ZodError } = require("zod");
const {
  generateEvidenceId,
  calculateHash,
  calculateParameterDigest,
  getOperationChain,
  listAllOperationChains,
  validateEvidenceChain,
  validateEvidenceChainFull,
  validateAllEvidenceChains,
  getEvidenceByOperationId,
  exportEvidenceChain,
  replayOperationFromEvidence,
  getEvidenceState,
  verifyParameterConsistency,
  HIGH_RISK_OPERATIONS,
  EVIDENCE_TYPES,
  EVIDENCE_ERROR_TYPES,
  ensureEvidenceDirs,
  simplifyChain,
  simplifyChainWithEvents,
  simplifyEvidence,
  simplifyEvidenceWithDetails,
  simplifyValidationIssue,
  simplifyReplayLogEntry,
  simplifyLogEntry
} = require("../services/evidence-chain-service");
const { EVIDENCE_ENABLED, EVIDENCE_LOG_FILE } = require("../config");
const { readLinesSafe } = require("../utils/file-store");
const { HttpError } = require("../utils/http-error");
const { requireRecoveryAuth } = require("../middleware/recovery-auth");

const listChainsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  operationType: z.string().optional()
});

const listLogsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

const replaySchema = z.object({
  dryRun: z.coerce.boolean().optional().default(true)
});

const verifyParametersSchema = z.object({
  evidenceId: z.string(),
  operationId: z.string().optional()
});

const validateSingleSchema = z.object({
  fullValidation: z.coerce.boolean().optional().default(true)
});

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof ZodError) {
        return next(new HttpError(422, "Validation failed", {
          errorType: EVIDENCE_ERROR_TYPES.INVALID_PARAMETERS,
          issues: error.issues.map(issue => ({
            field: issue.path.join("."),
            message: issue.message,
            code: issue.code
          }))
        }));
      }
      next(error);
    }
  };
}

function checkEvidenceEnabled() {
  if (!EVIDENCE_ENABLED) {
    throw new HttpError(503, "Evidence chain is disabled", {
      errorType: EVIDENCE_ERROR_TYPES.EVIDENCE_DISABLED
    });
  }
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
      state: {
        totalEvidenceCount: state.totalEvidenceCount,
        totalChains: state.totalChains,
        lastEvidenceId: state.lastEvidenceId,
        lastTimestamp: state.lastTimestamp,
        hasCorruption: state.hasCorruption
      },
      highRiskOperations: HIGH_RISK_OPERATIONS
    });
  }));

  router.get("/chains", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const params = listChainsSchema.parse(req.query);
    const result = await listAllOperationChains(params);

    res.json({
      ok: true,
      chains: result.chains.map(simplifyChain),
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  }));

  router.get("/chains/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const { operationId } = req.params;
    const chain = await getOperationChain(operationId);

    if (!chain) {
      throw new HttpError(404, "Operation chain not found", {
        errorType: EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND,
        operationId
      });
    }

    const evidenceResult = await getEvidenceByOperationId(operationId);

    res.json({
      ok: true,
      operationId,
      chain: simplifyChainWithEvents(chain),
      evidences: evidenceResult.success ? evidenceResult.evidences.map(simplifyEvidence) : []
    });
  }));

  router.post("/chains/:operationId/validate", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const { operationId } = req.params;
    const params = validateSingleSchema.parse(req.query);

    let validation;
    if (params.fullValidation) {
      validation = await validateEvidenceChainFull(operationId);
    } else {
      const chain = await getOperationChain(operationId);
      if (!chain) {
        throw new HttpError(404, "Operation chain not found", {
          errorType: EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND,
          operationId
        });
      }
      validation = await validateEvidenceChain(chain);
    }

    if (validation.issues.some(i => i.type === "chain_not_found")) {
      throw new HttpError(404, "Operation chain not found", {
        errorType: EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND,
        operationId
      });
    }

    res.json({
      ok: true,
      operationId,
      valid: validation.valid,
      issues: validation.issues.map(simplifyValidationIssue),
      warnings: validation.warnings.map(simplifyValidationIssue),
      details: {
        eventCount: validation.details.eventCount,
        validCount: validation.details.validCount,
        invalidCount: validation.details.invalidCount,
        hashValidation: validation.details.hashValidation
      }
    });
  }));

  router.post("/validate-all", requireRecoveryAuth, asyncHandler(async (_req, res) => {
    checkEvidenceEnabled();

    const result = await validateAllEvidenceChains();

    res.json({
      ok: true,
      total: result.total,
      valid: result.valid,
      invalid: result.invalid,
      failedChains: result.failedChains.map(fc => ({
        operationId: fc.operationId,
        operationType: fc.operationType,
        issues: fc.issues.map(simplifyValidationIssue)
      }))
    });
  }));

  router.post("/replay/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const { operationId } = req.params;
    const params = replaySchema.parse(req.body);

    const chain = await getOperationChain(operationId);
    if (!chain) {
      throw new HttpError(404, "Operation chain not found", {
        errorType: EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND,
        operationId
      });
    }

    const replayResult = await replayOperationFromEvidence(operationId, {
      dryRun: params.dryRun
    });

    if (!replayResult.success) {
      const errorType = replayResult.errorType || EVIDENCE_ERROR_TYPES.VALIDATION_FAILED;
      
      if (errorType === EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND) {
        throw new HttpError(404, replayResult.errorMessage || "Operation chain not found", {
          errorType,
          operationId,
          context: replayResult.context
        });
      }

      return res.json({
        ok: false,
        errorType,
        errorMessage: replayResult.errorMessage || "Replay failed",
        operationId,
        operationType: replayResult.operationType,
        canReplay: replayResult.canReplay,
        validationIssues: (replayResult.validationIssues || []).map(simplifyValidationIssue)
      });
    }

    res.json({
      ok: true,
      operationId,
      operationType: replayResult.operationType,
      dryRun: replayResult.dryRun,
      finalState: replayResult.finalState,
      eventCount: replayResult.eventCount,
      replayLog: replayResult.replayLog.map(simplifyReplayLogEntry),
      message: replayResult.message
    });
  }));

  router.get("/export/:operationId", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const { operationId } = req.params;

    const exportResult = await exportEvidenceChain(operationId);
    if (!exportResult.success) {
      throw new HttpError(404, exportResult.error || "Failed to export evidence chain", {
        errorType: EVIDENCE_ERROR_TYPES.CHAIN_NOT_FOUND,
        operationId
      });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="evidence_${operationId}_${Date.now()}.json"`
    );

    res.json(exportResult.exportData);
  }));

  router.post("/verify-parameters", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

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
      throw new HttpError(404, "Evidence not found", {
        errorType: EVIDENCE_ERROR_TYPES.EVIDENCE_NOT_FOUND,
        evidenceId
      });
    }

    const actualParameters = req.body.actualParameters || {};
    const result = await verifyParameterConsistency(evidence, actualParameters);

    res.json({
      ok: true,
      evidenceId,
      consistent: result.consistent,
      expectedDigest: result.expectedDigest,
      actualDigest: result.actualDigest
    });
  }));

  router.get("/logs", requireRecoveryAuth, asyncHandler(async (req, res) => {
    checkEvidenceEnabled();

    const params = listLogsSchema.parse(req.query);
    const { limit, offset } = params;

    const result = await readLinesSafe(EVIDENCE_LOG_FILE);
    if (!result.ok) {
      throw new HttpError(500, "Failed to read evidence log", {
        errorType: "read_failed"
      });
    }

    const logs = [];
    const start = Math.max(0, result.validLines.length - offset - limit);
    const end = result.validLines.length - offset;

    for (let i = start; i < end && i < result.validLines.length; i++) {
      try {
        const logEntry = JSON.parse(result.validLines[i].raw);
        logs.push(simplifyLogEntry(logEntry));
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
    checkEvidenceEnabled();

    const { evidenceId } = req.params;
    const result = await readLinesSafe(EVIDENCE_LOG_FILE);

    if (!result.ok) {
      throw new HttpError(500, "Failed to read evidence log", {
        errorType: "read_failed"
      });
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
      throw new HttpError(404, "Evidence not found", {
        errorType: EVIDENCE_ERROR_TYPES.EVIDENCE_NOT_FOUND,
        evidenceId
      });
    }

    res.json({
      ok: true,
      evidence: simplifyEvidenceWithDetails(evidence)
    });
  }));

  return router;
}

module.exports = {
  createEvidenceRouter
};
