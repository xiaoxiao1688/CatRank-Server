const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fsp = require("fs/promises");

const TEST_DATA_DIR = path.join(__dirname, "..", "test-data-core");

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

test("HttpError: creates error with status code and message", () => {
  const { HttpError } = require("../src/utils/http-error");
  
  const error = new HttpError(404, "Session not found");

  assert.strictEqual(error.statusCode, 404);
  assert.strictEqual(error.message, "Session not found");
  assert.strictEqual(error.name, "HttpError");
  assert.strictEqual(error.details, null);
});

test("HttpError: creates error with details", () => {
  const { HttpError } = require("../src/utils/http-error");
  
  const details = { currentState: "finished", allowedStates: ["playing"] };
  const error = new HttpError(409, "Session cannot be started", details);

  assert.strictEqual(error.statusCode, 409);
  assert.strictEqual(error.message, "Session cannot be started");
  assert.deepStrictEqual(error.details, details);
});

test("session state machine: created -> playing -> finished", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  
  const sessionService = createSessionService();

  const created = await sessionService.createSession({ playerName: "TestCat" });
  assert.strictEqual(created.state, SESSION_STATES.CREATED);
  assert.strictEqual(created.playerName, "TestCat");

  const started = await sessionService.startSession(created.id);
  assert.strictEqual(started.state, SESSION_STATES.PLAYING);
  assert.ok(started.startedAt);

  const event = await sessionService.addEvent(created.id, {
    type: "fish_caught",
    payload: { combo: 3 }
  });
  assert.ok(event.id);
  assert.strictEqual(event.type, "fish_caught");

  const finished = await sessionService.finishSession(created.id);
  assert.strictEqual(finished.state, SESSION_STATES.FINISHED);
  assert.ok(finished.finishedAt);
  assert.ok(finished.result);
  assert.ok(finished.result.score >= 0);
  assert.strictEqual(finished.submittedToLeaderboard, true);
});

test("session state machine: created -> closed", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  
  const sessionService = createSessionService();

  const created = await sessionService.createSession({ playerName: "TestCat" });
  assert.strictEqual(created.state, SESSION_STATES.CREATED);

  const closed = await sessionService.closeSession(created.id);
  assert.strictEqual(closed.state, SESSION_STATES.CLOSED);
  assert.ok(closed.closedAt);
  assert.strictEqual(closed.submittedToLeaderboard, false);
});

test("session state transitions: invalid transitions are rejected", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  
  const sessionService = createSessionService();

  const created = await sessionService.createSession({ playerName: "TestCat" });

  await assert.rejects(
    () => sessionService.finishSession(created.id),
    (error) => error.statusCode === 409
  );

  await assert.rejects(
    () => sessionService.addEvent(created.id, { type: "fish_caught" }),
    (error) => error.statusCode === 409
  );

  await sessionService.startSession(created.id);

  await assert.rejects(
    () => sessionService.startSession(created.id),
    (error) => error.statusCode === 409
  );

  await sessionService.finishSession(created.id);

  await assert.rejects(
    () => sessionService.startSession(created.id),
    (error) => error.statusCode === 409
  );

  await assert.rejects(
    () => sessionService.addEvent(created.id, { type: "fish_caught" }),
    (error) => error.statusCode === 409
  );

  await assert.rejects(
    () => sessionService.finishSession(created.id),
    (error) => error.statusCode === 409
  );

  await assert.rejects(
    () => sessionService.closeSession(created.id),
    (error) => error.statusCode === 409
  );
});

test("getSession returns session details", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  
  const sessionService = createSessionService();

  const created = await sessionService.createSession({ playerName: "TestCat" });
  const fetched = await sessionService.getSession(created.id);

  assert.strictEqual(fetched.id, created.id);
  assert.strictEqual(fetched.playerName, "TestCat");
  assert.strictEqual(fetched.state, SESSION_STATES.CREATED);
});

test("getSession throws 404 for non-existent session", async () => {
  const { createSessionService } = require("../src/services/session-service");
  
  const sessionService = createSessionService();

  await assert.rejects(
    () => sessionService.getSession("non-existent-id"),
    (error) => error.statusCode === 404
  );
});

test("playerName normalization", async () => {
  const { createSessionService } = require("../src/services/session-service");
  
  const sessionService = createSessionService();

  const session1 = await sessionService.createSession({});
  assert.strictEqual(session1.playerName, "Guest Cat");

  const session2 = await sessionService.createSession({ playerName: "  Multiple   Spaces  " });
  assert.strictEqual(session2.playerName, "Multiple Spaces");

  const longName = "a".repeat(30);
  const session3 = await sessionService.createSession({ playerName: longName });
  assert.strictEqual(session3.playerName.length, 20);
});

test("duplicate finish protection: same session cannot finish twice", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");
  
  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "DupCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  const firstFinish = await sessionService.finishSession(session.id);
  assert.strictEqual(firstFinish.submittedToLeaderboard, true);
  assert.ok(firstFinish.result);
  assert.ok(firstFinish.result.score >= 0);

  await assert.rejects(
    () => sessionService.finishSession(session.id),
    (error) => {
      assert.strictEqual(error.statusCode, 409);
      assert.ok(error.message.includes("already submitted"));
      return true;
    }
  );

  const entries = await listLeaderboardEntries();
  const sessionEntries = entries.filter((e) => e.sessionId === session.id);
  assert.strictEqual(sessionEntries.length, 1, "Should only have one leaderboard entry");
});

test("leaderboard entry contains all required fields", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { createLeaderboardService } = require("../src/services/leaderboard-service");
  
  const sessionService = createSessionService();
  const leaderboardService = createLeaderboardService();

  let session = await sessionService.createSession({ playerName: "ScoreCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });
  await sessionService.addEvent(session.id, { type: "golden_fish_caught" });
  await sessionService.addEvent(session.id, { type: "enemy_defeated" });
  await sessionService.addEvent(session.id, { type: "bomb_hit" });
  session = await sessionService.finishSession(session.id);

  const result = await leaderboardService.getLeaderboardPage({ page: 1, pageSize: 10 });
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.items.length, 1);

  const entry = result.items[0];
  assert.strictEqual(entry.rank, 1);
  assert.strictEqual(entry.sessionId, session.id);
  assert.strictEqual(entry.playerName, "ScoreCat");
  assert.ok(entry.score >= 0);
  assert.ok(entry.createdAt);
  assert.ok(entry.summary);
  assert.strictEqual(entry.summary.fishCaught, 1);
  assert.strictEqual(entry.summary.goldenFishCaught, 1);
  assert.strictEqual(entry.summary.enemyDefeated, 1);
  assert.strictEqual(entry.summary.bombHit, 1);
  assert.strictEqual(entry.summary.totalEvents, 4);
});

test("leaderboard pagination works correctly", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { createLeaderboardService } = require("../src/services/leaderboard-service");
  
  const sessionService = createSessionService();
  const leaderboardService = createLeaderboardService();

  for (let i = 0; i < 5; i++) {
    let session = await sessionService.createSession({ playerName: `Player${i}` });
    session = await sessionService.startSession(session.id);
    for (let j = 0; j <= i; j++) {
      await sessionService.addEvent(session.id, { type: "fish_caught" });
    }
    session = await sessionService.finishSession(session.id);
  }

  const page1 = await leaderboardService.getLeaderboardPage({ page: 1, pageSize: 2 });
  assert.strictEqual(page1.total, 5);
  assert.strictEqual(page1.page, 1);
  assert.strictEqual(page1.pageSize, 2);
  assert.strictEqual(page1.items.length, 2);

  const page2 = await leaderboardService.getLeaderboardPage({ page: 2, pageSize: 2 });
  assert.strictEqual(page2.page, 2);
  assert.strictEqual(page2.items.length, 2);

  const page3 = await leaderboardService.getLeaderboardPage({ page: 3, pageSize: 2 });
  assert.strictEqual(page3.page, 3);
  assert.strictEqual(page3.items.length, 1);
});

test("closed session does not appear in leaderboard", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { createLeaderboardService } = require("../src/services/leaderboard-service");
  
  const sessionService = createSessionService();
  const leaderboardService = createLeaderboardService();

  let closedSession = await sessionService.createSession({ playerName: "ClosedPlayer" });
  closedSession = await sessionService.startSession(closedSession.id);
  await sessionService.addEvent(closedSession.id, { type: "fish_caught" });
  closedSession = await sessionService.closeSession(closedSession.id);

  let finishedSession = await sessionService.createSession({ playerName: "FinishedPlayer" });
  finishedSession = await sessionService.startSession(finishedSession.id);
  await sessionService.addEvent(finishedSession.id, { type: "fish_caught" });
  finishedSession = await sessionService.finishSession(finishedSession.id);

  const result = await leaderboardService.getLeaderboardPage({ page: 1, pageSize: 10 });
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.items[0].playerName, "FinishedPlayer");
});

test("common error scenarios: 422 for invalid event type", async () => {
  const { createSessionService } = require("../src/services/session-service");
  
  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "Test" });
  session = await sessionService.startSession(session.id);

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "invalid_event_type" }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      assert.ok(error.message.includes("Unsupported event type"));
      return true;
    }
  );
});

test("common error scenarios: 422 for future event timestamp", async () => {
  const { createSessionService } = require("../src/services/session-service");
  
  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "Test" });
  session = await sessionService.startSession(session.id);

  const futureTime = Date.now() + 60000;

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "fish_caught", occurredAt: futureTime }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      assert.ok(error.message.includes("future"));
      return true;
    }
  );
});

test("cleanupExpiredSessions: returns 0 when no sessions exist", async () => {
  const { createSessionService } = require("../src/services/session-service");
  
  const sessionService = createSessionService();

  const expiredCount = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(expiredCount, 0);
});

test("cleanupExpiredSessions: returns 0 when no expired sessions", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  
  const sessionService = createSessionService();

  const session1 = await sessionService.createSession({ playerName: "Active1" });
  const session2 = await sessionService.createSession({ playerName: "Active2" });

  const expiredCount = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(expiredCount, 0);

  const check1 = await sessionService.getSession(session1.id);
  const check2 = await sessionService.getSession(session2.id);
  assert.strictEqual(check1.state, SESSION_STATES.CREATED);
  assert.strictEqual(check2.state, SESSION_STATES.CREATED);
});

test("expired session: created session can be marked as expired by cleanup", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { SESSION_TTL_MS } = require("../src/config");
  
  const sessionService = createSessionService();

  const session = await sessionService.createSession({ playerName: "ExpireCreated" });
  assert.strictEqual(session.state, SESSION_STATES.CREATED);

  const sessionFilePath = getSessionFilePath(session.id);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  const oldDate = new Date(Date.now() - SESSION_TTL_MS - 10000);
  sessionData.createdAt = oldDate.toISOString();
  await fsp.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  const expiredCount = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(expiredCount, 1);

  const expiredSession = await sessionService.getSession(session.id);
  assert.strictEqual(expiredSession.state, SESSION_STATES.EXPIRED);
  assert.ok(expiredSession.expiredAt);
});

test("expired session: finished session does not expire", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { SESSION_TTL_MS } = require("../src/config");
  
  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "FinishedSession" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });
  session = await sessionService.finishSession(session.id);

  assert.strictEqual(session.state, SESSION_STATES.FINISHED);

  const sessionFilePath = getSessionFilePath(session.id);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  const oldDate = new Date(Date.now() - SESSION_TTL_MS - 10000);
  sessionData.createdAt = oldDate.toISOString();
  sessionData.startedAt = oldDate.toISOString();
  await fsp.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  const expiredCount = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(expiredCount, 0);

  const stillFinished = await sessionService.getSession(session.id);
  assert.strictEqual(stillFinished.state, SESSION_STATES.FINISHED);
  assert.ok(!stillFinished.expiredAt);
});

test("expired session: closed session does not expire", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { SESSION_TTL_MS } = require("../src/config");
  
  const sessionService = createSessionService();

  let session = await sessionService.createSession({ playerName: "ClosedSession" });
  session = await sessionService.closeSession(session.id);

  assert.strictEqual(session.state, SESSION_STATES.CLOSED);

  const sessionFilePath = getSessionFilePath(session.id);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  const oldDate = new Date(Date.now() - SESSION_TTL_MS - 10000);
  sessionData.createdAt = oldDate.toISOString();
  await fsp.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  const expiredCount = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(expiredCount, 0);

  const stillClosed = await sessionService.getSession(session.id);
  assert.strictEqual(stillClosed.state, SESSION_STATES.CLOSED);
  assert.ok(!stillClosed.expiredAt);
});

test("expired session: access after cleanup throws 410", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { SESSION_TTL_MS } = require("../src/config");
  
  const sessionService = createSessionService();

  const session = await sessionService.createSession({ playerName: "AccessAfterExpiry" });
  assert.strictEqual(session.state, SESSION_STATES.CREATED);

  const sessionFilePath = getSessionFilePath(session.id);
  const sessionData = JSON.parse(await fsp.readFile(sessionFilePath, "utf-8"));
  const oldDate = new Date(Date.now() - SESSION_TTL_MS - 10000);
  sessionData.createdAt = oldDate.toISOString();
  await fsp.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  await assert.rejects(
    () => sessionService.startSession(session.id),
    (error) => {
      assert.strictEqual(error.statusCode, 410);
      assert.ok(error.message.includes("expired"));
      return true;
    }
  );

  const expiredSession = await sessionService.getSession(session.id);
  assert.strictEqual(expiredSession.state, SESSION_STATES.EXPIRED);
  assert.ok(expiredSession.expiredAt);
});

test("scoring service: calculates correct score", async () => {
  const { calculateSessionResult } = require("../src/services/scoring-service");
  const { EVENT_SCORES } = require("../src/game-rules");

  const events = [
    { type: "fish_caught", payload: { combo: 3 } },
    { type: "fish_caught", payload: { combo: 5 } },
    { type: "golden_fish_caught", payload: {} },
    { type: "enemy_defeated", payload: {} },
    { type: "bomb_hit", payload: {} },
  ];

  const result = calculateSessionResult(events);

  const expectedBaseScore = 
    EVENT_SCORES.fish_caught * 2 +
    EVENT_SCORES.golden_fish_caught +
    EVENT_SCORES.enemy_defeated +
    EVENT_SCORES.bomb_hit;

  const expectedComboBonus = Math.max(0, Math.floor(5 / 5) * 5);
  const expectedScore = Math.max(0, expectedBaseScore + expectedComboBonus);

  assert.strictEqual(result.score, expectedScore);
  assert.strictEqual(result.summary.fishCaught, 2);
  assert.strictEqual(result.summary.goldenFishCaught, 1);
  assert.strictEqual(result.summary.enemyDefeated, 1);
  assert.strictEqual(result.summary.bombHit, 1);
  assert.strictEqual(result.summary.maxCombo, 5);
  assert.strictEqual(result.summary.totalEvents, 5);
  assert.strictEqual(result.breakdown.baseScore, expectedBaseScore);
  assert.strictEqual(result.breakdown.comboBonus, expectedComboBonus);
});

test("scoring service: score cannot be negative", async () => {
  const { calculateSessionResult } = require("../src/services/scoring-service");

  const events = [
    { type: "bomb_hit", payload: {} },
    { type: "bomb_hit", payload: {} },
    { type: "bomb_hit", payload: {} },
  ];

  const result = calculateSessionResult(events);

  assert.ok(result.score >= 0);
  assert.strictEqual(result.summary.bombHit, 3);
});
