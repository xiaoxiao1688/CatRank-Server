const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fsp = require("fs/promises");

const TEST_DATA_DIR = path.join(__dirname, "..", "test-data-evidence");

async function cleanTestData() {
  try {
    await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

test.before(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.EVIDENCE_ENABLED = "true";
  await cleanTestData();
});

test.beforeEach(async () => {
  await cleanTestData();
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/services/evidence-chain-service")];
  delete require.cache[require.resolve("../src/services/operation-manager")];
});

test.after(async () => {
  delete process.env.DATA_DIR;
  delete process.env.EVIDENCE_ENABLED;
  await cleanTestData();
});

test("evidence chain: generateEvidenceId produces valid IDs", async () => {
  const { generateEvidenceId } = require("../src/services/evidence-chain-service");

  const id1 = generateEvidenceId();
  const id2 = generateEvidenceId();

  assert.ok(id1.startsWith("evid_"), "ID should start with 'evid_'");
  assert.ok(id2.startsWith("evid_"), "ID should start with 'evid_'");
  assert.notStrictEqual(id1, id2, "IDs should be unique");
});

test("evidence chain: calculateHash produces consistent hashes", async () => {
  const { calculateHash } = require("../src/services/evidence-chain-service");

  const data = { key: "value", number: 123 };
  const hash1 = calculateHash(data);
  const hash2 = calculateHash(data);

  assert.strictEqual(hash1, hash2, "Same data should produce same hash");
  assert.strictEqual(hash1.length, 64, "SHA256 hash should be 64 hex characters");
});

test("evidence chain: calculateParameterDigest handles parameters correctly", async () => {
  const { calculateParameterDigest } = require("../src/services/evidence-chain-service");

  const params1 = { a: 1, b: 2, c: 3 };
  const params2 = { c: 3, b: 2, a: 1 };
  const params3 = { a: 1, b: 2, c: 4 };

  const digest1 = calculateParameterDigest(params1);
  const digest2 = calculateParameterDigest(params2);
  const digest3 = calculateParameterDigest(params3);

  assert.strictEqual(digest1, digest2, "Same parameters in different order should have same digest");
  assert.notStrictEqual(digest1, digest3, "Different parameters should have different digests");
});

test("evidence chain: createEvidence creates valid evidence", async () => {
  const { createEvidence, getLastEvidenceHash } = require("../src/services/evidence-chain-service");

  const evidence = await createEvidence({
    operationType: "recovery",
    operationId: "op_test_123",
    eventType: "operation_started",
    state: "running",
    previousState: "pending",
    parameters: { dryRun: true, target: "test" },
    result: null,
    error: null
  });

  assert.ok(evidence.evidenceId.startsWith("evid_"), "Evidence should have valid evidenceId");
  assert.strictEqual(evidence.operationType, "recovery", "Operation type should match");
  assert.strictEqual(evidence.operationId, "op_test_123", "Operation ID should match");
  assert.strictEqual(evidence.eventType, "operation_started", "Event type should match");
  assert.strictEqual(evidence.state, "running", "State should match");
  assert.strictEqual(evidence.previousState, "pending", "Previous state should match");
  assert.ok(evidence.parameterDigest, "Should have parameter digest");
  assert.strictEqual(evidence.resultDigest, null, "Result digest should be null");
  assert.strictEqual(evidence.errorDigest, null, "Error digest should be null");
  assert.ok(evidence.prevHash, "Should have previous hash");
  assert.ok(evidence.currentHash, "Should have current hash");

  const lastHash = await getLastEvidenceHash();
  assert.strictEqual(lastHash, evidence.currentHash, "Last hash should match current evidence hash");
});

test("evidence chain: createEvidence builds proper hash chain", async () => {
  const { createEvidence, getLastEvidenceHash } = require("../src/services/evidence-chain-service");

  const evidence1 = await createEvidence({
    operationType: "recovery",
    operationId: "op_chain_test_1",
    eventType: "operation_created",
    state: "pending",
    previousState: null,
    parameters: { step: 1 }
  });

  const evidence2 = await createEvidence({
    operationType: "recovery",
    operationId: "op_chain_test_1",
    eventType: "operation_started",
    state: "running",
    previousState: "pending",
    parameters: { step: 2 }
  });

  const evidence3 = await createEvidence({
    operationType: "recovery",
    operationId: "op_chain_test_1",
    eventType: "operation_completed",
    state: "completed",
    previousState: "running",
    parameters: { step: 3 }
  });

  assert.strictEqual(evidence2.prevHash, evidence1.currentHash, "Second evidence prevHash should equal first evidence currentHash");
  assert.strictEqual(evidence3.prevHash, evidence2.currentHash, "Third evidence prevHash should equal second evidence currentHash");

  const lastHash = await getLastEvidenceHash();
  assert.strictEqual(lastHash, evidence3.currentHash, "Last hash should equal third evidence currentHash");
});

test("evidence chain: getOperationChain returns chain for operation", async () => {
  const { createEvidence, getOperationChain } = require("../src/services/evidence-chain-service");

  const operationId = "op_chain_get_test";

  await createEvidence({
    operationType: "import",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "import",
    operationId,
    eventType: "operation_started",
    state: "running",
    previousState: "pending"
  });

  const chain = await getOperationChain(operationId);

  assert.ok(chain, "Should return a chain");
  assert.strictEqual(chain.operationId, operationId, "Chain should have correct operationId");
  assert.strictEqual(chain.operationType, "import", "Chain should have correct operationType");
  assert.strictEqual(chain.events.length, 2, "Chain should have 2 events");
});

test("evidence chain: validateEvidenceChain detects broken chain", async () => {
  const { createEvidence, validateEvidenceChain, getOperationChain } = require("../src/services/evidence-chain-service");

  const operationId = "op_validate_broken_test";

  await createEvidence({
    operationType: "delete",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  const evidence2 = await createEvidence({
    operationType: "delete",
    operationId,
    eventType: "operation_started",
    state: "running",
    previousState: "pending"
  });

  const chain = await getOperationChain(operationId);

  const validResult = await validateEvidenceChain(chain);
  assert.strictEqual(validResult.valid, true, "Chain should be valid");
  assert.strictEqual(validResult.issues.length, 0, "Should have no issues");

  chain.events[1].prevHash = "invalid_hash_123";

  const invalidResult = await validateEvidenceChain(chain);
  assert.strictEqual(invalidResult.valid, false, "Chain should be invalid after tampering");
  assert.strictEqual(invalidResult.issues.length, 1, "Should have one issue");
  assert.strictEqual(invalidResult.issues[0].type, "chain_broken", "Issue type should be chain_broken");
});

test("evidence chain: validateEvidenceChain detects timestamp out of order", async () => {
  const { createEvidence, validateEvidenceChain, getOperationChain } = require("../src/services/evidence-chain-service");

  const operationId = "op_validate_time_test";

  await createEvidence({
    operationType: "restore",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "restore",
    operationId,
    eventType: "operation_started",
    state: "running",
    previousState: "pending"
  });

  const chain = await getOperationChain(operationId);

  const pastTime = new Date(Date.now() - 60000 * 60).toISOString();
  chain.events[1].timestamp = pastTime;

  const invalidResult = await validateEvidenceChain(chain);
  assert.strictEqual(invalidResult.valid, false, "Chain should be invalid with out-of-order timestamp");
  assert.strictEqual(invalidResult.issues.length, 1, "Should have one issue");
  assert.strictEqual(invalidResult.issues[0].type, "timestamp_out_of_order", "Issue type should be timestamp_out_of_order");
});

test("evidence chain: verifyParameterConsistency detects parameter tampering", async () => {
  const { createEvidence, verifyParameterConsistency } = require("../src/services/evidence-chain-service");

  const originalParams = {
    dryRun: true,
    target: "session_123",
    options: { preserveHistory: false }
  };

  const evidence = await createEvidence({
    operationType: "delete",
    operationId: "op_param_test",
    eventType: "operation_created",
    state: "pending",
    previousState: null,
    parameters: originalParams
  });

  const sameParamsResult = await verifyParameterConsistency(evidence, originalParams);
  assert.strictEqual(sameParamsResult.consistent, true, "Same parameters should be consistent");

  const modifiedParams = {
    dryRun: false,
    target: "session_123",
    options: { preserveHistory: false }
  };

  const modifiedResult = await verifyParameterConsistency(evidence, modifiedParams);
  assert.strictEqual(modifiedResult.consistent, false, "Modified parameters should be inconsistent");
  assert.notStrictEqual(modifiedResult.expectedDigest, modifiedResult.actualDigest, "Digests should be different");
});

test("evidence chain: getEvidenceByOperationId returns all evidences", async () => {
  const { createEvidence, getEvidenceByOperationId } = require("../src/services/evidence-chain-service");

  const operationId = "op_get_all_test";

  await createEvidence({
    operationType: "import",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null,
    parameters: { step: 1 }
  });

  await createEvidence({
    operationType: "import",
    operationId,
    eventType: "operation_started",
    state: "running",
    previousState: "pending",
    parameters: { step: 2 }
  });

  await createEvidence({
    operationType: "import",
    operationId,
    eventType: "operation_completed",
    state: "completed",
    previousState: "running",
    parameters: { step: 3 },
    result: { recordsProcessed: 100 }
  });

  const result = await getEvidenceByOperationId(operationId);

  assert.strictEqual(result.success, true, "Should succeed");
  assert.strictEqual(result.operationId, operationId, "Should have correct operationId");
  assert.strictEqual(result.operationType, "import", "Should have correct operationType");
  assert.strictEqual(result.evidences.length, 3, "Should have 3 evidences");

  assert.strictEqual(result.evidences[0].eventType, "operation_created", "First event should be operation_created");
  assert.strictEqual(result.evidences[1].eventType, "operation_started", "Second event should be operation_started");
  assert.strictEqual(result.evidences[2].eventType, "operation_completed", "Third event should be operation_completed");
});

test("evidence chain: replayOperationFromEvidence replays events", async () => {
  const { createEvidence, replayOperationFromEvidence } = require("../src/services/evidence-chain-service");

  const operationId = "op_replay_test";

  await createEvidence({
    operationType: "recovery",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null,
    parameters: { step: 1 }
  });

  await createEvidence({
    operationType: "recovery",
    operationId,
    eventType: "operation_started",
    state: "running",
    previousState: "pending",
    parameters: { step: 2 }
  });

  await createEvidence({
    operationType: "recovery",
    operationId,
    eventType: "operation_completed",
    state: "completed",
    previousState: "running",
    parameters: { step: 3 },
    result: { recoveredCount: 5 }
  });

  const result = await replayOperationFromEvidence(operationId, { dryRun: true });

  assert.strictEqual(result.success, true, "Replay should succeed");
  assert.strictEqual(result.operationId, operationId, "Should have correct operationId");
  assert.strictEqual(result.operationType, "recovery", "Should have correct operationType");
  assert.strictEqual(result.dryRun, true, "Should be dry run");
  assert.strictEqual(result.finalState, "completed", "Final state should be completed");
  assert.strictEqual(result.eventCount, 3, "Should have 3 events");
  assert.strictEqual(result.replayLog.length, 3, "Replay log should have 3 entries");

  assert.strictEqual(result.replayLog[0].targetState, "pending", "First step target state");
  assert.strictEqual(result.replayLog[1].targetState, "running", "Second step target state");
  assert.strictEqual(result.replayLog[2].targetState, "completed", "Third step target state");
});

test("evidence chain: exportEvidenceChain exports valid data", async () => {
  const { createEvidence, exportEvidenceChain } = require("../src/services/evidence-chain-service");

  const operationId = "op_export_test";

  await createEvidence({
    operationType: "delete",
    operationId,
    eventType: "operation_created",
    state: "pending",
    previousState: null,
    parameters: { reason: "test_cleanup" }
  });

  await createEvidence({
    operationType: "delete",
    operationId,
    eventType: "operation_completed",
    state: "completed",
    previousState: "pending",
    result: { deletedCount: 10 }
  });

  const result = await exportEvidenceChain(operationId);

  assert.strictEqual(result.success, true, "Export should succeed");
  assert.strictEqual(result.operationId, operationId, "Should have correct operationId");
  assert.ok(result.exportPath, "Should have export path");
  assert.ok(result.exportData, "Should have export data");

  assert.strictEqual(result.exportData.operationId, operationId, "Export data should have correct operationId");
  assert.strictEqual(result.exportData.operationType, "delete", "Export data should have correct operationType");
  assert.strictEqual(result.exportData.evidences.length, 2, "Export data should have 2 evidences");
  assert.ok(result.exportData.exportId, "Should have exportId");
  assert.ok(result.exportData.exportedAt, "Should have exportedAt timestamp");
});

test("evidence chain: getEvidenceState returns correct state", async () => {
  const { createEvidence, getEvidenceState } = require("../src/services/evidence-chain-service");

  const initialState = await getEvidenceState();
  assert.strictEqual(initialState.totalEvidenceCount, 0, "Should have 0 evidences initially");
  assert.strictEqual(initialState.totalChains, 0, "Should have 0 chains initially");

  await createEvidence({
    operationType: "recovery",
    operationId: "op_state_test_1",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "import",
    operationId: "op_state_test_2",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  const finalState = await getEvidenceState();
  assert.strictEqual(finalState.totalEvidenceCount, 2, "Should have 2 evidences");
  assert.strictEqual(finalState.totalChains, 2, "Should have 2 chains");
});

test("evidence chain: HIGH_RISK_OPERATIONS includes all required operations", async () => {
  const { HIGH_RISK_OPERATIONS } = require("../src/services/evidence-chain-service");

  assert.ok(HIGH_RISK_OPERATIONS.includes("recovery"), "Should include recovery");
  assert.ok(HIGH_RISK_OPERATIONS.includes("import"), "Should include import");
  assert.ok(HIGH_RISK_OPERATIONS.includes("restore"), "Should include restore");
  assert.ok(HIGH_RISK_OPERATIONS.includes("delete"), "Should include delete");
  assert.ok(HIGH_RISK_OPERATIONS.includes("export"), "Should include export");
});

test("evidence chain: validateAllEvidenceChains validates all chains", async () => {
  const { createEvidence, validateAllEvidenceChains } = require("../src/services/evidence-chain-service");

  await createEvidence({
    operationType: "recovery",
    operationId: "op_validate_all_1",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "import",
    operationId: "op_validate_all_2",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  const result = await validateAllEvidenceChains();

  assert.strictEqual(result.total, 2, "Should have 2 chains");
  assert.strictEqual(result.valid, 2, "Should have 2 valid chains");
  assert.strictEqual(result.invalid, 0, "Should have 0 invalid chains");
  assert.strictEqual(result.failedChains.length, 0, "Should have 0 failed chains");
});

test("evidence chain: listAllOperationChains returns paginated results", async () => {
  const { createEvidence, listAllOperationChains } = require("../src/services/evidence-chain-service");

  for (let i = 0; i < 5; i++) {
    await createEvidence({
      operationType: "recovery",
      operationId: `op_list_test_${i}`,
      eventType: "operation_created",
      state: "pending",
      previousState: null
    });
  }

  const result1 = await listAllOperationChains({ limit: 2, offset: 0 });
  assert.strictEqual(result1.total, 5, "Should have 5 total chains");
  assert.strictEqual(result1.chains.length, 2, "Should have 2 chains in first page");

  const result2 = await listAllOperationChains({ limit: 3, offset: 2 });
  assert.strictEqual(result2.total, 5, "Should have 5 total chains");
  assert.strictEqual(result2.chains.length, 3, "Should have 3 chains in second page");
});

test("evidence chain: listAllOperationChains filters by operationType", async () => {
  const { createEvidence, listAllOperationChains } = require("../src/services/evidence-chain-service");

  await createEvidence({
    operationType: "recovery",
    operationId: "op_filter_recovery",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "import",
    operationId: "op_filter_import",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  await createEvidence({
    operationType: "delete",
    operationId: "op_filter_delete",
    eventType: "operation_created",
    state: "pending",
    previousState: null
  });

  const recoveryResult = await listAllOperationChains({ operationType: "recovery" });
  assert.strictEqual(recoveryResult.total, 1, "Should have 1 recovery chain");
  assert.strictEqual(recoveryResult.chains[0].operationType, "recovery", "Should be recovery type");

  const importResult = await listAllOperationChains({ operationType: "import" });
  assert.strictEqual(importResult.total, 1, "Should have 1 import chain");
});
