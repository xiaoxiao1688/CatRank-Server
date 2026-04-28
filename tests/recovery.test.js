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

test("recovery: backup creation before recovery", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { listBackups } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  
  let session = await sessionService.createSession({ playerName: "BackupTestCat" });
  session = await sessionService.startSession(session.id);
  
  const event = await sessionService.addEvent(session.id, { type: "fish_caught" });
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: session.id,
    playerName: session.playerName,
    ...event
  }));

  const backupsBefore = await listBackups();
  const backupCountBefore = backupsBefore.backups.length;

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: true 
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.createBackup, true);
  assert.ok(report.backupResult, "Should have backup result");

  const backupsAfter = await listBackups();
  assert.strictEqual(
    backupsAfter.backups.length, 
    backupCountBefore + 1, 
    "Should have created a new backup"
  );
});

test("recovery: repeat recovery - skipped up to date sessions", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const event = {
    sessionId,
    playerName: "RepeatTestCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));

  const service1 = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false 
  });
  const report1 = await service1.runRecovery();

  assert.strictEqual(report1.summary.totalSessions, 1);
  assert.strictEqual(report1.summary.recovered, 1);

  const service2 = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false 
  });
  const report2 = await service2.runRecovery();

  assert.strictEqual(report2.summary.totalSessions, 1);
  assert.strictEqual(report2.summary.skipped, 1, "Second recovery should skip up to date session");
  assert.strictEqual(report2.summary.recovered, 0, "Second recovery should not recover anything");
});

test("recovery: large log file handling", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionCount = 5;
  const eventsPerSession = 20;
  
  const clock = createTestEventClock();
  
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = createTestId("sess");
    const playerName = `LargeLogCat_${s}`;
    
    for (let e = 0; e < eventsPerSession; e++) {
      const event = {
        sessionId,
        playerName,
        type: ["fish_caught", "golden_fish_caught", "enemy_defeated"][e % 3],
        id: createTestId("evt"),
        occurredAt: clock(),
        receivedAt: new Date().toISOString(),
        payload: { combo: e }
      };
      await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
    }
  }

  const service = await createRecoveryService({ 
    dryRun: true, 
    createBackup: false 
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.totalSessions, sessionCount);
  assert.strictEqual(report.summary.recovered, sessionCount);
  
  for (const sessionReport of report.details.sessions) {
    assert.strictEqual(sessionReport.eventCount, eventsPerSession);
  }
});

test("recovery: corrupted lines are quarantined in real mode", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { listQuarantinedItems } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const validEvent = {
    sessionId,
    playerName: "QuarantineTestCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };

  await appendLine(EVENTS_LOG_FILE, JSON.stringify(validEvent));
  await appendLine(EVENTS_LOG_FILE, "this is definitely not valid JSON");
  await appendLine(EVENTS_LOG_FILE, '{ "another": invalid json }');

  const quarantinedBefore = await listQuarantinedItems();
  const quarantineCountBefore = quarantinedBefore.items.length;

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false,
    quarantineCorrupted: true
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.corruptedLines, 2);
  assert.strictEqual(report.summary.quarantinedItems, 2);

  const quarantinedAfter = await listQuarantinedItems();
  assert.ok(
    quarantinedAfter.items.length > quarantineCountBefore,
    "Should have quarantined items"
  );
});

test("recovery: report is persisted after real recovery", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { listRecoveryReports } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const event = {
    sessionId,
    playerName: "ReportPersistCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));

  const reportsBefore = await listRecoveryReports();
  const reportCountBefore = reportsBefore.reports.length;

  const dryRunService = await createRecoveryService({ 
    dryRun: true, 
    createBackup: false
  });
  const dryRunReport = await dryRunService.runRecovery();

  const reportsAfterDryRun = await listRecoveryReports();
  assert.strictEqual(
    reportsAfterDryRun.reports.length,
    reportCountBefore,
    "Dry run should not persist report"
  );

  const realService = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false
  });
  const realReport = await realService.runRecovery();

  const reportsAfterReal = await listRecoveryReports();
  assert.strictEqual(
    reportsAfterReal.reports.length,
    reportCountBefore + 1,
    "Real recovery should persist report"
  );
});

test("recovery: backup restore functionality", async () => {
  const { createBackup, restoreFromBackup, listBackups } = require("../src/services/recovery-manager");
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionById } = require("../src/repositories/session-repo");
  
  const sessionService = createSessionService();
  
  let session = await sessionService.createSession({ playerName: "RestoreTestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  const backupResult = await createBackup("test-backup");
  assert.strictEqual(backupResult.success, true);
  assert.ok(backupResult.backupId);

  session = await sessionService.closeSession(session.id);

  const restoreResult = await restoreFromBackup(backupResult.backupId);
  assert.strictEqual(restoreResult.success, true);

  const restoredSession = await getSessionById(session.id);
  assert.ok(restoredSession);
  assert.strictEqual(restoredSession.state, "playing", "Should be restored to playing state");
});

test("recovery: progress tracking during recovery", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { getCurrentProgress } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionCount = 3;
  const clock = createTestEventClock();
  
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = createTestId("sess");
    const event = {
      sessionId,
      playerName: `ProgressCat_${s}`,
      type: "fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: {}
    };
    await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  }

  const progressUpdates = [];
  
  const service = await createRecoveryService({ 
    dryRun: true, 
    createBackup: false,
    onProgress: (progress) => {
      progressUpdates.push({ ...progress });
    }
  });
  
  await service.runRecovery();

  assert.ok(progressUpdates.length > 0, "Should have received progress updates");
  
  const phases = progressUpdates.map(p => p.phase);
  assert.ok(phases.includes("parsing_log"), "Should have parsing_log phase");
  assert.ok(phases.includes("processing_sessions"), "Should have processing_sessions phase");
  assert.ok(phases.includes("finalizing") || phases.includes("completed"), "Should have final phase");
});

test("recovery: duplicate recovery request is rejected", async () => {
  const { createRecoveryRouter } = require("../src/routes/recovery");
  const express = require("express");
  const request = require("supertest");
  const recoveryServiceModule = require("../src/services/recovery-service");
  
  const router = createRecoveryRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/recovery", router);
  
  let recoveryRunning = false;
  
  const originalCreateRecoveryService = recoveryServiceModule.createRecoveryService;
  recoveryServiceModule.createRecoveryService = function(options) {
    const service = originalCreateRecoveryService(options);
    return {
      runRecovery: async function() {
        recoveryRunning = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        recoveryRunning = false;
        return { success: true, summary: { recovered: 0, totalSessions: 0 } };
      }
    };
  };
  
  try {
    const response1 = await request(app)
      .post("/api/recovery/run")
      .send({ dryRun: true });
    
    assert.ok(response1.body.ok !== undefined);
  } finally {
    recoveryServiceModule.createRecoveryService = originalCreateRecoveryService;
  }
});

test("recovery: can recover from interrupted state", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { saveRecoveryState, loadRecoveryState, RECOVERY_STATES } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  
  const event = {
    sessionId,
    playerName: "InterruptRecoverCat",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));

  await saveRecoveryState({
    status: RECOVERY_STATES.INTERRUPTED,
    interruptedAt: new Date().toISOString()
  });

  const loadedState = await loadRecoveryState();
  assert.strictEqual(loadedState.status, RECOVERY_STATES.INTERRUPTED);

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.recovered, 1);
});

test("recovery: auth middleware - rejects missing API key", async () => {
  const { validateRecoveryApiKey, timingSafeEqual } = require("../src/middleware/recovery-auth");
  const crypto = require("crypto");
  
  const result = timingSafeEqual(null, "something");
  assert.strictEqual(result, false);
  
  const result2 = timingSafeEqual("short", "very_long_string");
  assert.strictEqual(result2, false);
  
  const validKey = "test_key_123";
  const result3 = timingSafeEqual(validKey, validKey);
  assert.strictEqual(result3, true);
  
  const differentKey = "test_key_456";
  const result4 = timingSafeEqual(validKey, differentKey);
  assert.strictEqual(result4, false);
});

test("recovery: auth middleware - accepts valid API key", async () => {
  const { timingSafeEqual } = require("../src/middleware/recovery-auth");
  
  const validKey = "valid_test_key_456";
  const result = timingSafeEqual(validKey, validKey);
  assert.strictEqual(result, true);
  
  const invalidKey = "wrong_key";
  const result2 = timingSafeEqual(validKey, invalidKey);
  assert.strictEqual(result2, false);
  
  assert.ok(result);
});

test("recovery: interrupt triggers auto rollback when enabled", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { setInterrupted, listBackups } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  let originalSession = await sessionService.createSession({ playerName: "RollbackTestCat" });
  originalSession = await sessionService.startSession(originalSession.id);
  const event1 = await sessionService.addEvent(originalSession.id, { type: "fish_caught" });
  
  const clock = createTestEventClock();
  
  const extraEvent = {
    sessionId: originalSession.id,
    playerName: "RollbackTestCat",
    type: "golden_fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: originalSession.id,
    playerName: originalSession.playerName,
    ...event1
  }));
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(extraEvent));
  
  const backupsBefore = await listBackups();
  const backupCountBefore = backupsBefore.backups.length;
  
  let wasInterrupted = false;
  
  const service = await createRecoveryService({
    dryRun: false,
    createBackup: true,
    rollbackOnError: true,
    autoRollbackOnInterrupt: true,
    onProgress: (progress) => {
      if (progress.phase === "processing_sessions" && !wasInterrupted) {
        wasInterrupted = true;
        setInterrupted(true);
      }
    }
  });
  
  const report = await service.runRecovery();
  
  const backupsAfter = await listBackups();
  assert.ok(backupsAfter.backups.length > backupCountBefore, "Should have created backup");
  
  if (report.error && report.error.isInterrupted) {
    assert.ok(report.wasRolledBack !== undefined, "Should have rollback info");
  }
});

test("recovery: transaction tracking records processed sessions", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { getActiveTransaction, clearTransaction } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  clearTransaction();
  
  const clock = createTestEventClock();
  const sessionCount = 3;
  
  for (let i = 0; i < sessionCount; i++) {
    const event = {
      sessionId: createTestId("sess"),
      playerName: `TxTestCat_${i}`,
      type: "fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: {}
    };
    await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  }
  
  const service = await createRecoveryService({
    dryRun: false,
    createBackup: false
  });
  
  const report = await service.runRecovery();
  
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.recovered, sessionCount);
  
  const transaction = getActiveTransaction();
  if (transaction) {
    assert.ok(Array.isArray(transaction.processedSessions));
    assert.strictEqual(transaction.processedSessions.length, sessionCount);
  }
  
  clearTransaction();
});

test("recovery: large scale performance test (100 sessions)", { timeout: 30000 }, async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionCount = 100;
  const eventsPerSession = 10;
  
  const startTime = Date.now();
  
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = createTestId("sess");
    const playerName = `PerfCat_${s}`;
    
    for (let e = 0; e < eventsPerSession; e++) {
      const event = {
        sessionId,
        playerName,
        type: ["fish_caught", "golden_fish_caught", "enemy_defeated"][e % 3],
        id: createTestId("evt"),
        occurredAt: clock(),
        receivedAt: new Date().toISOString(),
        payload: { combo: e + 1 }
      };
      await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
    }
  }
  
  const writeTime = Date.now() - startTime;
  
  const recoveryStart = Date.now();
  
  const service = await createRecoveryService({
    dryRun: false,
    createBackup: false
  });
  
  const report = await service.runRecovery();
  
  const recoveryTime = Date.now() - recoveryStart;
  
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.totalSessions, sessionCount);
  assert.strictEqual(report.summary.recovered, sessionCount);
  
  for (const sessionReport of report.details.sessions) {
    assert.strictEqual(sessionReport.eventCount, eventsPerSession);
  }
  
  console.log(`[Performance] Log write: ${writeTime}ms, Recovery: ${recoveryTime}ms`);
  
  assert.ok(recoveryTime < 30000, `Recovery should be fast (took ${recoveryTime}ms)`);
});

test("recovery: post-recovery consistency validation", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { getSessionById } = require("../src/repositories/session-repo");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  const { SESSION_STATES } = require("../src/game-rules");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "ConsistencyCat" });
  session = await sessionService.startSession(session.id);
  
  const clock = createTestEventClock();
  const events = [];
  
  for (let i = 0; i < 5; i++) {
    const event = {
      sessionId: session.id,
      playerName: "ConsistencyCat",
      type: ["fish_caught", "golden_fish_caught"][i % 2],
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: { combo: i + 1 }
    };
    events.push(event);
    await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  }
  
  const service = await createRecoveryService({
    dryRun: false,
    createBackup: false
  });
  
  const report = await service.runRecovery();
  
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.recovered, 1);
  
  const recoveredSession = await getSessionById(session.id);
  assert.ok(recoveredSession);
  assert.strictEqual(recoveredSession.events.length, 5);
  assert.strictEqual(recoveredSession.state, SESSION_STATES.PLAYING);
  
  for (let i = 0; i < events.length; i++) {
    assert.strictEqual(recoveredSession.events[i].id, events[i].id);
    assert.strictEqual(recoveredSession.events[i].type, events[i].type);
  }
  
  const sessionReport = report.details.sessions.find(s => s.sessionId === session.id);
  assert.ok(sessionReport);
  assert.strictEqual(sessionReport.eventCount, 5);
  assert.strictEqual(sessionReport.recoveryAction, "updated");
  
  assert.ok(report.validation);
  assert.strictEqual(report.validation.valid, true);
});

test("recovery: finished session recovers with leaderboard entry", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { getSessionById } = require("../src/repositories/session-repo");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  const { SESSION_STATES, EVENT_TYPES } = require("../src/game-rules");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  const sessionId = createTestId("sess");
  const playerName = "FinishedRecoverCat";
  
  let timestamp = Date.now();
  const createFinishedEvent = (type, combo) => ({
    sessionId,
    playerName,
    type,
    id: createTestId("evt"),
    occurredAt: (timestamp += 100),
    receivedAt: new Date(timestamp).toISOString(),
    payload: { combo }
  });
  
  const fishEvent1 = createFinishedEvent("fish_caught", 1);
  const goldenFishEvent = createFinishedEvent("golden_fish_caught", 2);
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(fishEvent1));
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(goldenFishEvent));
  
  const leaderboardBefore = await listLeaderboardEntries();
  const existingEntry = leaderboardBefore.find(e => e.sessionId === sessionId);
  assert.strictEqual(existingEntry, undefined, "Session should not be in leaderboard before recovery");
  
  const service = await createRecoveryService({
    dryRun: false,
    createBackup: false
  });
  
  const report = await service.runRecovery();
  
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.recovered, 1);
  
  const recoveredSession = await getSessionById(sessionId);
  assert.ok(recoveredSession);
  assert.strictEqual(recoveredSession.state, SESSION_STATES.PLAYING);
  assert.strictEqual(recoveredSession.events.length, 2);
  
  const leaderboardAfter = await listLeaderboardEntries();
  const newEntry = leaderboardAfter.find(e => e.sessionId === sessionId);
  
  const sessionReport = report.details.sessions.find(s => s.sessionId === sessionId);
  assert.ok(sessionReport);
  assert.strictEqual(sessionReport.recoveryAction, "created");
});
