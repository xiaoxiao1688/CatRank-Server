const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fsp = require("fs/promises");

const TEST_DATA_DIR = path.join(__dirname, "..", "test-data-recovery");

async function cleanTestData() {
  try {
    await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function createEventClock(startAt = Date.now()) {
  let current = startAt;
  return function nextEventTime(stepMs = 15) {
    current += stepMs;
    return current;
  };
}

function createTestEventClock(startAt = Date.now()) {
  let current = startAt;
  return function nextEventTime(stepMs = 15) {
    current += stepMs;
    return current;
  };
}

function createTestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

test.before(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  await cleanTestData();
});

test.beforeEach(async () => {
  await cleanTestData();
});

test.after(async () => {
  delete process.env.DATA_DIR;
  await cleanTestData();
});

test("recovery: session file loss recovery", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  const playerName = "LostSessionCat";
  
  const events = [
    {
      sessionId,
      playerName,
      type: "fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: { combo: 1 }
    },
    {
      sessionId,
      playerName,
      type: "golden_fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: { combo: 2 }
    }
  ];

  for (const event of events) {
    await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  }

  const sessionFilesBefore = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(sessionFilesBefore.length, 0, "Should have no session files initially");

  const dryRunService = await createRecoveryService({ dryRun: true });
  const dryRunReport = await dryRunService.runRecovery();

  assert.strictEqual(dryRunReport.dryRun, true);
  assert.strictEqual(dryRunReport.summary.totalSessions, 1);
  assert.strictEqual(dryRunReport.summary.recovered, 1);
  
  const sessionFilesAfterDryRun = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(sessionFilesAfterDryRun.length, 0, "Dry run should not create session files");

  const realService = await createRecoveryService({ dryRun: false });
  const realReport = await realService.runRecovery();

  assert.strictEqual(realReport.dryRun, false);
  assert.strictEqual(realReport.summary.totalSessions, 1);
  assert.strictEqual(realReport.summary.recovered, 1);

  const sessionFilesAfterReal = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(sessionFilesAfterReal.length, 1, "Real recovery should create session file");
  
  const sessionFilePath = path.join(SESSION_DIR, sessionFilesAfterReal[0]);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  
  assert.strictEqual(sessionData.id, sessionId);
  assert.strictEqual(sessionData.playerName, playerName);
  assert.strictEqual(sessionData.events.length, 2);
});

test("recovery: corrupted log lines detection", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  const playerName = "CorruptTestCat";
  
  const validEvent = {
    sessionId,
    playerName,
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };

  await appendLine(EVENTS_LOG_FILE, JSON.stringify(validEvent));
  await appendLine(EVENTS_LOG_FILE, "this is not valid json");
  await appendLine(EVENTS_LOG_FILE, '{ "invalid": structure }');
  
  const anotherValid = {
    ...validEvent,
    id: createTestId("evt"),
    occurredAt: clock()
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(anotherValid));

  const service = await createRecoveryService({ dryRun: true });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.corruptedLines, 2, "Should detect 2 corrupted lines");
  assert.strictEqual(report.summary.totalSessions, 1, "Should still parse valid events");
  assert.strictEqual(report.details.corruptedLines.length, 2);
});

test("recovery: duplicate events detection", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  const eventId = createTestId("evt");
  
  const event1 = {
    sessionId,
    playerName: "DupCat",
    type: "fish_caught",
    id: eventId,
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };

  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event1));
  
  const event2 = {
    sessionId,
    playerName: "DupCat",
    type: "golden_fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event2));
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event1));

  const service = await createRecoveryService({ dryRun: true });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.duplicateEvents, 1, "Should detect 1 duplicate event");
  assert.strictEqual(report.details.duplicateEvents.length, 1);
  
  const sessionReport = report.details.sessions.find(s => s.sessionId === sessionId);
  assert.ok(sessionReport, "Session should be in report");
  assert.strictEqual(sessionReport.hasDuplicates, true);
  assert.strictEqual(sessionReport.eventCount, 2, "Should only have 2 unique events");
});

test("recovery: state conflicts detection - closed session with events", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  
  let session = await sessionService.createSession({ playerName: "ClosedCat" });
  session = await sessionService.startSession(session.id);
  
  const event = await sessionService.addEvent(session.id, { type: "fish_caught" });
  
  session = await sessionService.closeSession(session.id);
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event
  }));

  const service = await createRecoveryService({ dryRun: true });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.stateConflicts, 1, "Should detect state conflict");
  assert.strictEqual(report.summary.failed, 1, "Should mark as failed");
  
  const sessionReport = report.details.sessions.find(s => s.sessionId === session.id);
  assert.ok(sessionReport, "Session should be in report");
  assert.strictEqual(sessionReport.hasStateConflicts, true);
  assert.strictEqual(sessionReport.canRecover, false, "Should not be recoverable");
});

test("recovery: leaderboard duplicate entry protection", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  const nextEventTime = createEventClock();
  
  let session = await sessionService.createSession({ playerName: "LeaderboardCat" });
  session = await sessionService.startSession(session.id);
  
  const event1 = await sessionService.addEvent(session.id, {
    type: "fish_caught",
    occurredAt: nextEventTime()
  });
  const event2 = await sessionService.addEvent(session.id, {
    type: "golden_fish_caught",
    occurredAt: nextEventTime()
  });
  
  session = await sessionService.finishSession(session.id);
  
  const leaderboardBefore = await listLeaderboardEntries();
  const sessionEntry = leaderboardBefore.find(e => e.sessionId === session.id);
  assert.ok(sessionEntry, "Session should be in leaderboard after finish");
  assert.strictEqual(leaderboardBefore.length, 1, "Should have 1 entry");
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event1
  }));
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event2
  }));

  const recoveryService = await createRecoveryService({ dryRun: false });
  const report = await recoveryService.runRecovery();

  assert.strictEqual(report.summary.totalSessions, 1);

  const leaderboardAfter = await listLeaderboardEntries();
  assert.strictEqual(leaderboardAfter.length, 1, "Should still have only 1 leaderboard entry");
  
  const finalEntry = leaderboardAfter.find(e => e.sessionId === session.id);
  assert.ok(finalEntry, "Session should still be in leaderboard");
  assert.strictEqual(finalEntry.score, sessionEntry.score, "Score should match");
});

test("recovery: dry-run vs real mode comparison", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const event = {
    sessionId,
    playerName: "DryRunCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));

  const dryRunService = await createRecoveryService({ dryRun: true });
  const dryRunReport = await dryRunService.runRecovery();

  assert.strictEqual(dryRunReport.dryRun, true);
  
  const filesAfterDryRun = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(filesAfterDryRun.length, 0, "Dry run should not create files");

  const realService = await createRecoveryService({ dryRun: false });
  const realReport = await realService.runRecovery();

  assert.strictEqual(realReport.dryRun, false);
  
  const filesAfterReal = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(filesAfterReal.length, 1, "Real mode should create session file");
});

test("recovery: existing session update with new events from log", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  
  let session = await sessionService.createSession({ playerName: "UpdateTestCat" });
  session = await sessionService.startSession(session.id);
  
  const event1 = await sessionService.addEvent(session.id, { type: "fish_caught" });

  const sessionFilePath = path.join(SESSION_DIR, `${session.id}.json`);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  assert.strictEqual(sessionData.events.length, 1);

  const event2 = {
    sessionId: session.id,
    playerName: session.playerName,
    type: "golden_fish_caught",
    id: createTestId("evt"),
    occurredAt: Date.now() + 1000,
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event1
  }));
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event2));

  const recoveryService = await createRecoveryService({ dryRun: false });
  const report = await recoveryService.runRecovery();

  assert.strictEqual(report.summary.totalSessions, 1);
  
  const sessionReport = report.details.sessions.find(s => s.sessionId === session.id);
  assert.ok(sessionReport, "Session should be in report");
  assert.strictEqual(sessionReport.recoveryAction, "updated", "Should update existing session");
  assert.strictEqual(sessionReport.eventCount, 2, "Should have 2 events now");

  const updatedSessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  assert.strictEqual(updatedSessionData.events.length, 2, "Session file should be updated with 2 events");
});

test("recovery: report structure validation", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const event = {
    sessionId,
    playerName: "ReportCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  await appendLine(EVENTS_LOG_FILE, "invalid json here");

  const service = await createRecoveryService({ dryRun: true });
  const report = await service.runRecovery();

  assert.ok(report.timestamp, "Report should have timestamp");
  assert.strictEqual(typeof report.dryRun, "boolean", "dryRun should be boolean");
  assert.ok(report.summary, "Report should have summary");
  
  assert.strictEqual(typeof report.summary.totalSessions, "number");
  assert.strictEqual(typeof report.summary.recovered, "number");
  assert.strictEqual(typeof report.summary.skipped, "number");
  assert.strictEqual(typeof report.summary.failed, "number");
  assert.strictEqual(typeof report.summary.corruptedLines, "number");
  assert.strictEqual(typeof report.summary.duplicateEvents, "number");
  assert.strictEqual(typeof report.summary.stateConflicts, "number");
  
  assert.ok(report.details, "Report should have details");
  assert.ok(Array.isArray(report.details.sessions), "sessions should be array");
  assert.ok(Array.isArray(report.details.corruptedLines), "corruptedLines should be array");
  assert.ok(Array.isArray(report.details.duplicateEvents), "duplicateEvents should be array");
});

test("recovery: expired session with events conflict", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { appendLine, ensureDir, writeJsonAtomic } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR, SESSION_TTL_MS } = require("../src/config");
  const { SESSION_STATES } = require("../src/game-rules");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  
  let session = await sessionService.createSession({ playerName: "ExpiredCat" });
  session = await sessionService.startSession(session.id);
  
  const event = await sessionService.addEvent(session.id, { type: "fish_caught" });

  const sessionFilePath = getSessionFilePath(session.id);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  const oldDate = new Date(Date.now() - SESSION_TTL_MS - 10000);
  sessionData.createdAt = oldDate.toISOString();
  sessionData.startedAt = oldDate.toISOString();
  sessionData.state = SESSION_STATES.EXPIRED;
  sessionData.expiredAt = new Date().toISOString();
  await writeJsonAtomic(sessionFilePath, sessionData);

  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event
  }));

  const service = await createRecoveryService({ dryRun: true });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.stateConflicts, 1, "Should detect state conflict for expired session");
  assert.strictEqual(report.summary.failed, 1, "Should mark as failed");
});
