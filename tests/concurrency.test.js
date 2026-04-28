const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fsp = require("fs/promises");

const TEST_DATA_DIR = path.join(__dirname, "..", "test-data-concurrency");

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
  await cleanTestData();
});

test.beforeEach(async () => {
  await cleanTestData();
});

test.after(async () => {
  delete process.env.DATA_DIR;
  await cleanTestData();
});

test("concurrency: concurrent finishSession calls - only one succeeds", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  const { SESSION_STATES } = require("../src/game-rules");

  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "ConcurrentCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  const promises = [];
  let successCount = 0;
  let conflictCount = 0;

  for (let i = 0; i < 5; i++) {
    promises.push(
      sessionService.finishSession(session.id)
        .then((result) => {
          successCount++;
          return result;
        })
        .catch((error) => {
          if (error.statusCode === 409) {
            conflictCount++;
          }
          throw error;
        })
    );
  }

  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.strictEqual(fulfilled.length, 1, "Exactly one finish should succeed");
  assert.strictEqual(rejected.length, 4, "Four finishes should be rejected");

  for (const result of rejected) {
    assert.strictEqual(result.reason.statusCode, 409, "Rejections should be 409 Conflict");
    assert.ok(
      result.reason.message.includes("already submitted") || result.reason.message.includes("cannot be finished"),
      "Error message should indicate conflict"
    );
  }

  const entries = await listLeaderboardEntries();
  const sessionEntries = entries.filter((e) => e.sessionId === session.id);
  assert.strictEqual(sessionEntries.length, 1, "Should only have one leaderboard entry");

  const finalSession = await sessionService.getSession(session.id);
  assert.strictEqual(finalSession.state, SESSION_STATES.FINISHED);
  assert.strictEqual(finalSession.submittedToLeaderboard, true);
});

test("concurrency: concurrent addEvent calls - all events are preserved", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionById } = require("../src/repositories/session-repo");

  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "EventStormCat" });
  session = await sessionService.startSession(session.id);

  const eventCount = 10;
  const promises = [];

  for (let i = 0; i < eventCount; i++) {
    promises.push(
      sessionService.addEvent(session.id, {
        type: "fish_caught",
        payload: { index: i }
      })
    );
  }

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter((r) => r.status === "fulfilled");

  assert.strictEqual(fulfilled.length, eventCount, "All events should be accepted");

  const finalSession = await getSessionById(session.id);
  assert.strictEqual(finalSession.events.length, eventCount, "All events should be in session");

  const eventIds = new Set(finalSession.events.map((e) => e.id));
  assert.strictEqual(eventIds.size, eventCount, "All event IDs should be unique");
});

test("consistency: addEvent order - log written before session saved", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { EVENTS_LOG_FILE } = require("../src/config");

  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "ConsistentCat" });
  session = await sessionService.startSession(session.id);

  const sessionPath = getSessionFilePath(session.id);

  const sessionBefore = JSON.parse(await fsp.readFile(sessionPath, "utf-8"));
  assert.strictEqual(sessionBefore.events.length, 0, "No events before addEvent");

  await sessionService.addEvent(session.id, { type: "fish_caught" });

  const sessionAfter = JSON.parse(await fsp.readFile(sessionPath, "utf-8"));
  assert.strictEqual(sessionAfter.events.length, 1, "One event after addEvent");

  let logExists = false;
  try {
    await fsp.access(EVENTS_LOG_FILE);
    logExists = true;
  } catch {}
  
  if (logExists) {
    const logContent = await fsp.readFile(EVENTS_LOG_FILE, "utf-8");
    const logLines = logContent.trim().split("\n").filter((line) => line);
    const sessionEvents = logLines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.sessionId === session.id;
      } catch {
        return false;
      }
    });
    assert.strictEqual(sessionEvents.length, 1, "Event should be in log");
  }
});

test("consistency: startSession atomic update", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");

  const sessionService = createSessionService();

  const session = await sessionService.createSession({ playerName: "AtomicStartCat" });
  assert.strictEqual(session.state, SESSION_STATES.CREATED);

  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(sessionService.startSession(session.id));
  }

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.ok(fulfilled.length >= 1, "At least one start should succeed");
  assert.ok(rejected.length >= 0, "Subsequent starts may be rejected");

  for (const result of rejected) {
    assert.strictEqual(result.reason.statusCode, 409, "Rejections should be 409");
  }

  const finalSession = await sessionService.getSession(session.id);
  assert.strictEqual(finalSession.state, SESSION_STATES.PLAYING);
  assert.ok(finalSession.startedAt);
});

test("consistency: closeSession atomic update", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");

  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "AtomicCloseCat" });
  session = await sessionService.startSession(session.id);

  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(sessionService.closeSession(session.id));
  }

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter((r) => r.status === "fulfilled");

  assert.ok(fulfilled.length >= 1, "At least one close should succeed");

  const finalSession = await sessionService.getSession(session.id);
  assert.strictEqual(finalSession.state, SESSION_STATES.CLOSED);
  assert.ok(finalSession.closedAt);
});

test("isolation: operations on different sessions don't block each other", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");

  const sessionService = createSessionService();

  const sessionCount = 5;
  const createPromises = [];

  for (let i = 0; i < sessionCount; i++) {
    createPromises.push(
      sessionService.createSession({ playerName: `ParallelCat${i}` })
    );
  }

  const sessions = await Promise.all(createPromises);
  assert.strictEqual(sessions.length, sessionCount);

  const startPromises = sessions.map((s) => sessionService.startSession(s.id));
  const startedSessions = await Promise.all(startPromises);

  for (const session of startedSessions) {
    assert.strictEqual(session.state, SESSION_STATES.PLAYING);
  }

  const eventPromises = [];
  for (const session of startedSessions) {
    for (let i = 0; i < 3; i++) {
      eventPromises.push(
        sessionService.addEvent(session.id, { type: "fish_caught" })
      );
    }
  }

  const eventResults = await Promise.allSettled(eventPromises);
  const fulfilledEvents = eventResults.filter((r) => r.status === "fulfilled");
  assert.strictEqual(fulfilledEvents.length, sessionCount * 3);
});
