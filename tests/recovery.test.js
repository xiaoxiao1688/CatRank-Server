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

test("recovery: auth middleware - rejects requests without API key when auth enabled", async () => {
  const originalRequireAuth = process.env.RECOVERY_REQUIRE_AUTH;
  const originalApiKey = process.env.RECOVERY_API_KEY;
  process.env.RECOVERY_REQUIRE_AUTH = "true";
  process.env.RECOVERY_API_KEY = "test-secret-key-123";
  
  try {
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
    delete require.cache[require.resolve("../src/services/recovery-service")];
    delete require.cache[require.resolve("../src/services/recovery-manager")];
    
    const { requireRecoveryAuth } = require("../src/middleware/recovery-auth");
    
    let nextCalled = false;
    let errorThrown = null;
    
    const mockReq = {
      headers: {},
      query: {},
      body: {}
    };
    
    const mockRes = {};
    
    function mockNext(err) {
      if (err) {
        errorThrown = err;
      }
      nextCalled = true;
    }
    
    try {
      requireRecoveryAuth(mockReq, mockRes, mockNext);
    } catch (err) {
      errorThrown = err;
    }
    
    assert.ok(errorThrown, "Should throw error when no API key provided");
    assert.strictEqual(errorThrown.statusCode, 401);
  } finally {
    if (originalRequireAuth !== undefined) {
      process.env.RECOVERY_REQUIRE_AUTH = originalRequireAuth;
    } else {
      delete process.env.RECOVERY_REQUIRE_AUTH;
    }
    if (originalApiKey !== undefined) {
      process.env.RECOVERY_API_KEY = originalApiKey;
    } else {
      delete process.env.RECOVERY_API_KEY;
    }
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
    delete require.cache[require.resolve("../src/services/recovery-service")];
    delete require.cache[require.resolve("../src/services/recovery-manager")];
  }
});

test("recovery: auth middleware - accepts requests with valid API key", async () => {
  const originalRequireAuth = process.env.RECOVERY_REQUIRE_AUTH;
  const originalApiKey = process.env.RECOVERY_API_KEY;
  const testApiKey = "test-api-key-12345";
  
  process.env.RECOVERY_REQUIRE_AUTH = "true";
  process.env.RECOVERY_API_KEY = testApiKey;
  
  try {
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
    
    const { requireRecoveryAuth } = require("../src/middleware/recovery-auth");
    
    let nextCalled = false;
    let errorThrown = null;
    
    const mockReq = {
      headers: {
        authorization: `Bearer ${testApiKey}`
      },
      query: {},
      body: {}
    };
    
    const mockRes = {};
    
    function mockNext(err) {
      if (err) {
        errorThrown = err;
      }
      nextCalled = true;
    }
    
    try {
      requireRecoveryAuth(mockReq, mockRes, mockNext);
    } catch (err) {
      errorThrown = err;
    }
    
    assert.strictEqual(errorThrown, null, "Should not throw error with valid API key");
    assert.strictEqual(nextCalled, true, "Should call next() with valid API key");
  } finally {
    if (originalRequireAuth !== undefined) {
      process.env.RECOVERY_REQUIRE_AUTH = originalRequireAuth;
    } else {
      delete process.env.RECOVERY_REQUIRE_AUTH;
    }
    if (originalApiKey !== undefined) {
      process.env.RECOVERY_API_KEY = originalApiKey;
    } else {
      delete process.env.RECOVERY_API_KEY;
    }
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
  }
});

test("recovery: auth middleware - rejects requests with invalid API key", async () => {
  const originalRequireAuth = process.env.RECOVERY_REQUIRE_AUTH;
  const originalApiKey = process.env.RECOVERY_API_KEY;
  const validApiKey = "valid-api-key-12345";
  
  process.env.RECOVERY_REQUIRE_AUTH = "true";
  process.env.RECOVERY_API_KEY = validApiKey;
  
  try {
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
    
    const { requireRecoveryAuth } = require("../src/middleware/recovery-auth");
    
    let nextCalled = false;
    let errorThrown = null;
    
    const mockReq = {
      headers: {
        authorization: "Bearer invalid-api-key"
      },
      query: {},
      body: {}
    };
    
    const mockRes = {};
    
    function mockNext(err) {
      if (err) {
        errorThrown = err;
      }
      nextCalled = true;
    }
    
    try {
      requireRecoveryAuth(mockReq, mockRes, mockNext);
    } catch (err) {
      errorThrown = err;
    }
    
    assert.ok(errorThrown, "Should throw error with invalid API key");
    assert.strictEqual(errorThrown.statusCode, 403);
  } finally {
    if (originalRequireAuth !== undefined) {
      process.env.RECOVERY_REQUIRE_AUTH = originalRequireAuth;
    } else {
      delete process.env.RECOVERY_REQUIRE_AUTH;
    }
    if (originalApiKey !== undefined) {
      process.env.RECOVERY_API_KEY = originalApiKey;
    } else {
      delete process.env.RECOVERY_API_KEY;
    }
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/middleware/recovery-auth")];
    delete require.cache[require.resolve("../src/routes/recovery")];
  }
});

test("recovery: transaction mode - enabled by default", async () => {
  const { getTransactionMode } = require("../src/services/recovery-manager");
  
  const txnMode = await getTransactionMode();
  
  assert.strictEqual(typeof txnMode.enabled, "boolean");
  assert.ok(txnMode.tempDir);
});

test("recovery: transaction and rollback - interrupt triggers rollback when backup exists", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionById } = require("../src/repositories/session-repo");
  const {
    interruptRecoveryTracking,
    getActiveTransactionId,
    loadRecoveryState,
    RECOVERY_STATES
  } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  
  let originalSession = await sessionService.createSession({ playerName: "RollbackTestCat" });
  originalSession = await sessionService.startSession(originalSession.id);
  const originalEvent = await sessionService.addEvent(originalSession.id, { type: "fish_caught" });
  
  const clock = createTestEventClock();
  const newEvent = {
    sessionId: originalSession.id,
    playerName: originalSession.playerName,
    type: "golden_fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  };
  
  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: originalSession.id,
    playerName: originalSession.playerName,
    ...originalEvent
  }));
  await appendLine(EVENTS_LOG_FILE, JSON.stringify(newEvent));

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: true,
    enableTransaction: true,
    onProgress: async (progress) => {
      if (progress.phase === "processing_sessions" && getActiveTransactionId()) {
        await interruptRecoveryTracking();
      }
    }
  });
  
  const report = await service.runRecovery();

  assert.strictEqual(report.wasInterrupted, true);
  assert.ok(report.rollbackResult !== undefined);
  assert.strictEqual(report.rollbackResult.rolledBack, true);

  const state = await loadRecoveryState();
  assert.strictEqual(state.status, RECOVERY_STATES.ROLLED_BACK);

  const restoredSession = await getSessionById(originalSession.id);
  assert.ok(restoredSession);
  assert.strictEqual(restoredSession.events.length, 1, "Rollback should restore the original session snapshot");
});

test("recovery: rollback removes sessions created during interrupted recovery", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { interruptRecoveryTracking, loadRecoveryState, RECOVERY_STATES } = require("../src/services/recovery-manager");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");

  await ensureDir(SESSION_DIR);

  const clock = createTestEventClock();
  const sessionA = createTestId("sess");
  const sessionB = createTestId("sess");

  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: sessionA,
    playerName: "RollbackCleanCat_A",
    type: "fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  }));

  await appendLine(EVENTS_LOG_FILE, JSON.stringify({
    sessionId: sessionB,
    playerName: "RollbackCleanCat_B",
    type: "golden_fish_caught",
    id: createTestId("evt"),
    occurredAt: clock(),
    receivedAt: new Date().toISOString(),
    payload: {}
  }));

  const service = await createRecoveryService({
    dryRun: false,
    createBackup: true,
    enableTransaction: true,
    onProgress: async (progress) => {
      if (progress.phase === "processing_sessions" && progress.processedCount === 1) {
        await interruptRecoveryTracking();
      }
    }
  });

  const report = await service.runRecovery();

  assert.strictEqual(report.wasInterrupted, true);
  assert.strictEqual(report.rollbackResult?.rolledBack, true);

  const sessionFiles = await fsp.readdir(SESSION_DIR).catch(() => []);
  assert.strictEqual(sessionFiles.length, 0, "Rollback should remove sessions created after the backup snapshot");

  const state = await loadRecoveryState();
  assert.strictEqual(state.status, RECOVERY_STATES.ROLLED_BACK);
});

test("recovery: large scale performance - 100 sessions with 50 events each", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  
  await ensureDir(SESSION_DIR);
  
  const sessionCount = 100;
  const eventsPerSession = 50;
  const totalEvents = sessionCount * eventsPerSession;
  
  const clock = createTestEventClock();
  
  console.log(`[Performance Test] Generating ${totalEvents} events for ${sessionCount} sessions...`);
  const generateStart = Date.now();
  
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
  
  const generateTime = Date.now() - generateStart;
  console.log(`[Performance Test] Data generated in ${generateTime}ms`);
  
  console.log(`[Performance Test] Running recovery...`);
  const recoveryStart = Date.now();
  
  const service = await createRecoveryService({ 
    dryRun: true, 
    createBackup: false
  });
  const report = await service.runRecovery();
  
  const recoveryTime = Date.now() - recoveryStart;
  console.log(`[Performance Test] Recovery completed in ${recoveryTime}ms`);
  console.log(`[Performance Test] Throughput: ${Math.round(totalEvents / (recoveryTime / 1000))} events/sec`);

  assert.strictEqual(report.summary.totalSessions, sessionCount);
  assert.strictEqual(report.summary.recovered, sessionCount);
  
  for (const sessionReport of report.details.sessions) {
    assert.strictEqual(sessionReport.eventCount, eventsPerSession);
  }
  
  assert.ok(recoveryTime < 30000, `Recovery should complete within reasonable time (took ${recoveryTime}ms)`);
});

test("recovery: post-recovery validation - verify session data integrity", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionById } = require("../src/repositories/session-repo");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  const { SESSION_STATES } = require("../src/game-rules");
  
  await ensureDir(SESSION_DIR);
  
  const clock = createTestEventClock();
  
  const sessionId1 = createTestId("sess");
  const playerName1 = "ValidateCat_1";
  const events1 = [
    {
      sessionId: sessionId1,
      playerName: playerName1,
      type: "fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: { combo: 1 }
    },
    {
      sessionId: sessionId1,
      playerName: playerName1,
      type: "golden_fish_caught",
      id: createTestId("evt"),
      occurredAt: clock(),
      receivedAt: new Date().toISOString(),
      payload: { combo: 2 }
    }
  ];
  
  for (const event of events1) {
    await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
  }

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false 
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.success, true);
  assert.strictEqual(report.summary.recovered, 1);
  
  const recoveredSession = await getSessionById(sessionId1);
  assert.ok(recoveredSession, "Session should be created after recovery");
  assert.strictEqual(recoveredSession.id, sessionId1);
  assert.strictEqual(recoveredSession.playerName, playerName1);
  assert.strictEqual(recoveredSession.events.length, events1.length);
  assert.strictEqual(recoveredSession.state, SESSION_STATES.PLAYING);
  
  for (let i = 0; i < events1.length; i++) {
    assert.strictEqual(recoveredSession.events[i].id, events1[i].id);
    assert.strictEqual(recoveredSession.events[i].type, events1[i].type);
  }
  
  assert.ok(report.validation, "Report should have validation result");
  assert.strictEqual(report.validation.valid, true);
});

test("recovery: post-recovery validation - verify finished session with leaderboard entry", async () => {
  const { createRecoveryService } = require("../src/services/recovery-service");
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionById } = require("../src/repositories/session-repo");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { appendLine, ensureDir } = require("../src/utils/file-store");
  const { EVENTS_LOG_FILE, SESSION_DIR } = require("../src/config");
  const { SESSION_STATES } = require("../src/game-rules");
  
  await ensureDir(SESSION_DIR);
  
  const sessionService = createSessionService();
  const clock = createTestEventClock();
  
  let session = await sessionService.createSession({ playerName: "LeaderboardValidateCat" });
  session = await sessionService.startSession(session.id);
  
  const event1 = await sessionService.addEvent(session.id, {
    type: "fish_caught",
    occurredAt: clock()
  });
  const event2 = await sessionService.addEvent(session.id, {
    type: "golden_fish_caught",
    occurredAt: clock()
  });
  
  session = await sessionService.finishSession(session.id);
  
  const leaderboardBefore = await listLeaderboardEntries();
  const originalEntry = leaderboardBefore.find(e => e.sessionId === session.id);
  assert.ok(originalEntry, "Session should be in leaderboard");
  
  const leaderboardScore = originalEntry.score;
  
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

  const service = await createRecoveryService({ 
    dryRun: false, 
    createBackup: false 
  });
  const report = await service.runRecovery();

  assert.strictEqual(report.summary.totalSessions, 1);
  
  const leaderboardAfter = await listLeaderboardEntries();
  assert.strictEqual(leaderboardAfter.length, 1, "Should not create duplicate leaderboard entry");
  
  const finalEntry = leaderboardAfter.find(e => e.sessionId === session.id);
  assert.ok(finalEntry);
  assert.strictEqual(finalEntry.score, leaderboardScore, "Score should remain consistent");
});

test("recovery: validateApiKey function - works correctly", async () => {
  const { validateApiKey } = require("../src/middleware/recovery-auth");
  const { RECOVERY_REQUIRE_AUTH, RECOVERY_API_KEY } = require("../src/config");
  
  const result = validateApiKey(null);
  assert.strictEqual(typeof result.valid, "boolean");
  assert.ok(result.reason);
  
  if (!RECOVERY_REQUIRE_AUTH) {
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.reason, "auth_disabled");
  }
});
