const crypto = require("crypto");
const path = require("path");
const fsp = require("fs/promises");

const {
  EVIDENCE_DIR,
  EVIDENCE_LOG_FILE,
  EVIDENCE_STATE_FILE,
  EVIDENCE_MAX_TIME_SKEW_MS,
  EVIDENCE_HASH_ALGORITHM
} = require("../config");
const { ensureDir, appendLine, readLinesSafe, readJson, writeJsonAtomic, listJsonFiles } = require("../utils/file-store");
const { createId } = require("../utils/id");

const EVIDENCE_TYPES = {
  OPERATION_STARTED: "operation_started",
  OPERATION_PROGRESS: "operation_progress",
  OPERATION_COMPLETED: "operation_completed",
  OPERATION_FAILED: "operation_failed",
  OPERATION_CANCELLED: "operation_cancelled",
  OPERATION_ROLLING_BACK: "operation_rolling_back",
  OPERATION_ROLLED_BACK: "operation_rolled_back",
  DATA_RECOVERY: "data_recovery",
  DATA_IMPORT: "data_import",
  DATA_EXPORT: "data_export",
  DATA_RESTORE: "data_restore",
  DATA_DELETE: "data_delete",
  STATE_CHANGE: "state_change"
};

const HIGH_RISK_OPERATIONS = [
  "recovery",
  "import",
  "restore",
  "delete",
  "export"
];

let lastEvidenceHash = null;
let lastEvidenceTimestamp = null;

function generateEvidenceId() {
  return `evid_${Date.now()}_${createId("ev").slice(-8)}`;
}

function calculateHash(data, algorithm = EVIDENCE_HASH_ALGORITHM) {
  const stringified = typeof data === "string" ? data : JSON.stringify(data);
  return crypto.createHash(algorithm).update(stringified, "utf8").digest("hex");
}

function calculateParameterDigest(params) {
  if (!params || Object.keys(params).length === 0) {
    return null;
  }
  const sortedKeys = Object.keys(params).sort();
  const normalized = {};
  for (const key of sortedKeys) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      normalized[key] = value;
    }
  }
  return calculateHash(normalized);
}

function buildEvidenceChainLink(prevHash, currentData) {
  const chainInput = {
    prevHash,
    ...currentData
  };
  return calculateHash(chainInput);
}

async function ensureEvidenceDirs() {
  await ensureDir(EVIDENCE_DIR);
  await ensureDir(path.join(EVIDENCE_DIR, "chains"));
  await ensureDir(path.join(EVIDENCE_DIR, "exports"));
}

async function getLastEvidenceHash() {
  if (lastEvidenceHash) {
    return lastEvidenceHash;
  }

  const result = await readLinesSafe(EVIDENCE_LOG_FILE);
  if (!result.ok || result.validLines.length === 0) {
    return "00000000000000000000000000000000000000000000000000000000000000";
  }

  try {
    const lastLine = result.validLines[result.validLines.length - 1];
    const lastEvidence = JSON.parse(lastLine.raw);
    lastEvidenceHash = lastEvidence.currentHash;
    lastEvidenceTimestamp = lastEvidence.timestamp;
    return lastEvidenceHash;
  } catch {
    return "00000000000000000000000000000000000000000000000000000000000000";
  }
}

async function createEvidence(options) {
  const {
    operationType,
    operationId,
    eventType,
    state,
    previousState,
    parameters,
    result,
    error,
    metadata = {}
  } = options;

  await ensureEvidenceDirs();

  const evidenceId = generateEvidenceId();
  const timestamp = new Date().toISOString();
  const timestampMs = Date.now();

  if (lastEvidenceTimestamp) {
    const lastTime = new Date(lastEvidenceTimestamp).getTime();
    if (timestampMs < lastTime - EVIDENCE_MAX_TIME_SKEW_MS) {
      throw new Error(`Evidence timestamp out of order: current ${timestamp} is earlier than previous ${lastEvidenceTimestamp}`);
    }
  }

  const prevHash = await getLastEvidenceHash();

  const parameterDigest = calculateParameterDigest(parameters);
  const resultDigest = result ? calculateHash(result) : null;
  const errorDigest = error ? calculateHash({ message: error.message, stack: error.stack?.slice(0, 1000) }) : null;

  const evidenceData = {
    evidenceId,
    operationType,
    operationId,
    eventType,
    timestamp,
    state,
    previousState,
    parameterDigest,
    resultDigest,
    errorDigest,
    metadata,
    parameters: Object.keys(parameters || {}).length > 0 ? parameters : undefined,
    result: result ? (typeof result === "object" ? result : { value: result }) : undefined,
    error: error ? { message: error.message, stack: error.stack?.slice(0, 2000) } : undefined
  };

  const currentHash = buildEvidenceChainLink(prevHash, evidenceData);

  const evidence = {
    ...evidenceData,
    prevHash,
    currentHash
  };

  await appendLine(EVIDENCE_LOG_FILE, JSON.stringify(evidence));

  lastEvidenceHash = currentHash;
  lastEvidenceTimestamp = timestamp;

  if (operationId) {
    await appendToOperationChain(operationId, evidence);
  }

  return evidence;
}

async function appendToOperationChain(operationId, evidence) {
  const chainDir = path.join(EVIDENCE_DIR, "chains");
  const chainFile = path.join(chainDir, `${operationId}.json`);

  let chain = await readJson(chainFile, null);
  if (!chain) {
    chain = {
      operationId,
      operationType: evidence.operationType,
      createdAt: evidence.timestamp,
      events: []
    };
  }

  chain.events.push({
    evidenceId: evidence.evidenceId,
    eventType: evidence.eventType,
    timestamp: evidence.timestamp,
    state: evidence.state,
    previousState: evidence.previousState,
    currentHash: evidence.currentHash,
    prevHash: evidence.prevHash
  });

  chain.updatedAt = evidence.timestamp;
  chain.lastEvidenceId = evidence.evidenceId;
  chain.lastHash = evidence.currentHash;

  await writeJsonAtomic(chainFile, chain);
}

async function getOperationChain(operationId) {
  const chainFile = path.join(EVIDENCE_DIR, "chains", `${operationId}.json`);
  const chain = await readJson(chainFile, null);
  return chain;
}

async function listAllOperationChains(options = {}) {
  const { limit = 50, offset = 0, operationType = null } = options;
  const chainDir = path.join(EVIDENCE_DIR, "chains");

  const files = await listJsonFiles(chainDir);
  const chains = [];

  for (const file of files) {
    try {
      const chain = await readJson(file, null);
      if (chain) {
        if (operationType && chain.operationType !== operationType) {
          continue;
        }
        chains.push(chain);
      }
    } catch {
      continue;
    }
  }

  chains.sort((a, b) => {
    return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
  });

  return {
    chains: chains.slice(offset, offset + limit),
    total: chains.length,
    limit,
    offset
  };
}

async function validateEvidenceChain(chain) {
  const issues = [];
  const warnings = [];

  if (!chain || !chain.events || chain.events.length === 0) {
    return {
      valid: true,
      issues: [],
      warnings: [{ type: "empty_chain", message: "Chain has no events" }],
      details: { eventCount: 0, validCount: 0, invalidCount: 0 }
    };
  }

  let validCount = 0;
  let invalidCount = 0;
  let prevTime = null;

  for (let i = 0; i < chain.events.length; i++) {
    const event = chain.events[i];
    const eventIndex = i + 1;

    const currentTime = new Date(event.timestamp).getTime();
    if (prevTime !== null) {
      if (currentTime < prevTime - EVIDENCE_MAX_TIME_SKEW_MS) {
        issues.push({
          type: "timestamp_out_of_order",
          severity: "error",
          eventIndex,
          evidenceId: event.evidenceId,
          message: `Event ${eventIndex} timestamp ${event.timestamp} is earlier than previous event`,
          previousTime: new Date(prevTime).toISOString(),
          currentTime: event.timestamp
        });
        invalidCount++;
      }
    }
    prevTime = currentTime;

    if (i > 0) {
      const prevEvent = chain.events[i - 1];
      if (event.prevHash !== prevEvent.currentHash) {
        issues.push({
          type: "chain_broken",
          severity: "error",
          eventIndex,
          evidenceId: event.evidenceId,
          message: `Hash chain broken at event ${eventIndex}`,
          expectedHash: prevEvent.currentHash,
          actualHash: event.prevHash
        });
        invalidCount++;
      } else {
        validCount++;
      }
    } else {
      validCount++;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    details: {
      eventCount: chain.events.length,
      validCount,
      invalidCount
    }
  };
}

async function validateAllEvidenceChains() {
  const result = await listAllOperationChains({ limit: 10000 });
  const validationResults = [];

  for (const chain of result.chains) {
    const validation = await validateEvidenceChain(chain);
    validationResults.push({
      operationId: chain.operationId,
      operationType: chain.operationType,
      ...validation
    });
  }

  const failedValidations = validationResults.filter(v => !v.valid);
  const passedValidations = validationResults.filter(v => v.valid);

  return {
    total: validationResults.length,
    valid: passedValidations.length,
    invalid: failedValidations.length,
    results: validationResults,
    failedChains: failedValidations.map(v => ({
      operationId: v.operationId,
      operationType: v.operationType,
      issues: v.issues
    }))
  };
}

async function getEvidenceByOperationId(operationId) {
  const chain = await getOperationChain(operationId);
  if (!chain) {
    return { success: false, error: "Operation chain not found", operationId };
  }

  const result = await readLinesSafe(EVIDENCE_LOG_FILE);
  if (!result.ok) {
    return { success: false, error: "Failed to read evidence log", operationId };
  }

  const evidences = [];
  for (const line of result.validLines) {
    try {
      const evidence = JSON.parse(line.raw);
      if (evidence.operationId === operationId) {
        evidences.push(evidence);
      }
    } catch {
      continue;
    }
  }

  evidences.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    success: true,
    operationId,
    operationType: chain.operationType,
    evidences,
    chain
  };
}

async function exportEvidenceChain(operationId) {
  const result = await getEvidenceByOperationId(operationId);
  if (!result.success) {
    return result;
  }

  const exportData = {
    exportId: `export_evid_${Date.now()}`,
    exportedAt: new Date().toISOString(),
    operationId,
    operationType: result.operationType,
    evidences: result.evidences,
    chain: result.chain
  };

  const exportDir = path.join(EVIDENCE_DIR, "exports");
  const exportFile = path.join(exportDir, `evidence_${operationId}_${Date.now()}.json`);

  await ensureDir(exportDir);
  await writeJsonAtomic(exportFile, exportData);

  return {
    success: true,
    operationId,
    exportPath: exportFile,
    exportData
  };
}

async function replayOperationFromEvidence(operationId, options = {}) {
  const { dryRun = true, onProgress = null } = options;

  const result = await getEvidenceByOperationId(operationId);
  if (!result.success) {
    return result;
  }

  const evidences = result.evidences;
  const replayLog = [];
  let currentState = null;

  for (let i = 0; i < evidences.length; i++) {
    const evidence = evidences[i];
    const step = i + 1;

    if (onProgress) {
      onProgress({
        step,
        total: evidences.length,
        evidenceId: evidence.evidenceId,
        eventType: evidence.eventType,
        state: evidence.state
      });
    }

    replayLog.push({
      step,
      evidenceId: evidence.evidenceId,
      eventType: evidence.eventType,
      timestamp: evidence.timestamp,
      previousState: evidence.previousState,
      targetState: evidence.state,
      parameters: evidence.parameters,
      parameterDigest: evidence.parameterDigest,
      result: evidence.result,
      resultDigest: evidence.resultDigest
    });

    currentState = evidence.state;
  }

  return {
    success: true,
    operationId,
    operationType: result.operationType,
    dryRun,
    finalState: currentState,
    eventCount: evidences.length,
    replayLog,
    canReplay: true,
    message: dryRun ? "Dry run completed - no actual changes made" : "Replay completed"
  };
}

async function getEvidenceState() {
  const state = await readJson(EVIDENCE_STATE_FILE, {
    totalEvidenceCount: 0,
    lastEvidenceId: null,
    lastHash: null,
    lastTimestamp: null,
    corruptedChains: [],
    initializedAt: new Date().toISOString()
  });

  const logResult = await readLinesSafe(EVIDENCE_LOG_FILE);
  const chainResult = await listAllOperationChains({ limit: 10000 });

  return {
    ...state,
    totalEvidenceCount: logResult.ok ? logResult.validLines.length : 0,
    totalChains: chainResult.total,
    hasCorruption: logResult.hasCorruption,
    corruptedLineNumbers: logResult.invalidLineNumbers || []
  };
}

async function verifyParameterConsistency(evidence, actualParameters) {
  const actualDigest = calculateParameterDigest(actualParameters);
  const expectedDigest = evidence.parameterDigest;

  return {
    consistent: actualDigest === expectedDigest,
    expectedDigest,
    actualDigest,
    evidenceParameters: evidence.parameters,
    actualParameters
  };
}

module.exports = {
  EVIDENCE_TYPES,
  HIGH_RISK_OPERATIONS,
  generateEvidenceId,
  calculateHash,
  calculateParameterDigest,
  buildEvidenceChainLink,
  ensureEvidenceDirs,
  getLastEvidenceHash,
  createEvidence,
  appendToOperationChain,
  getOperationChain,
  listAllOperationChains,
  validateEvidenceChain,
  validateAllEvidenceChains,
  getEvidenceByOperationId,
  exportEvidenceChain,
  replayOperationFromEvidence,
  getEvidenceState,
  verifyParameterConsistency
};
