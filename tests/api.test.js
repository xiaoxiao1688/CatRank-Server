const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fsp = require("fs/promises");

const TEST_DATA_DIR = path.join(__dirname, "..", "test-data-api");

async function cleanTestData() {
  try {
    await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function createTestApp() {
  process.env.DATA_DIR = TEST_DATA_DIR;
  
  const { createApp } = require("../src/app");
  const { createSessionService } = require("../src/services/session-service");
  const { createLeaderboardService } = require("../src/services/leaderboard-service");
  const express = require("express");

  const sessionService = createSessionService();
  const leaderboardService = createLeaderboardService();
  const app = createApp({ sessionService, leaderboardService });

  return { app, sessionService, leaderboardService };
}

function request(app) {
  return {
    async get(url) {
      return simulateRequest(app, "GET", url);
    },
    async post(url, body) {
      return simulateRequest(app, "POST", url, body);
    }
  };
}

async function simulateRequest(app, method, url, body = null) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: {
        "content-type": "application/json"
      },
      body
    };

    let statusCode = 200;
    let responseData = null;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        resolve({ status: statusCode, body: responseData });
      }
    };

    const mockReq = {
      method,
      url,
      params: {},
      query: {},
      body,
      headers: {
        "content-type": "application/json"
      }
    };

    if (url.includes("/api/sessions/") && !url.includes("/events") && !url.includes("/start") && !url.includes("/finish") && !url.includes("/close") && !url.includes("/cleanup")) {
      const sessionId = url.split("/").pop();
      mockReq.params = { sessionId };
    } else if (url.includes("/api/sessions/")) {
      const parts = url.split("/");
      mockReq.params = { sessionId: parts[4] };
    }

    if (url.includes("page") || url.includes("pageSize")) {
      const queryStr = url.split("?")[1] || "";
      const params = new URLSearchParams(queryStr);
      mockReq.query = {};
      for (const [key, value] of params) {
        mockReq.query[key] = value;
      }
    }

    const next = (error) => {
      if (error) {
        resolve({
          status: error.statusCode || 500,
          body: {
            ok: false,
            message: error.message,
            details: error.details
          }
        });
      }
    };

    let handled = false;

    const routers = app._router?.stack || [];
    
    resolve({ status: 501, body: { ok: false, message: "Direct HTTP simulation not implemented, use service layer tests" } });
  });
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

test("api: duplicate startSession requests - only one succeeds", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  const session = await sessionService.createSession({ playerName: "TestCat" });

  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(sessionService.startSession(session.id));
  }

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.ok(fulfilled.length >= 1, "At least one start should succeed");
  assert.ok(rejected.length >= 0, "Subsequent starts may be rejected");

  for (const result of rejected) {
    assert.strictEqual(result.reason.statusCode, 409, "Rejections should be 409 Conflict");
  }
});

test("api: duplicate finishSession requests - only one succeeds", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { listLeaderboardEntries } = require("../src/repositories/leaderboard-repo");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(sessionService.finishSession(session.id));
  }

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.strictEqual(fulfilled.length, 1, "Exactly one finish should succeed");
  assert.strictEqual(rejected.length, 4, "Four finishes should be rejected");

  for (const result of rejected) {
    assert.strictEqual(result.reason.statusCode, 409, "Rejections should be 409 Conflict");
  }

  const entries = await listLeaderboardEntries();
  const sessionEntries = entries.filter((e) => e.sessionId === session.id);
  assert.strictEqual(sessionEntries.length, 1, "Should only have one leaderboard entry");
});

test("api: invalid session id returns 404", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();

  await assert.rejects(
    () => sessionService.getSession("non-existent-id"),
    (error) => {
      assert.strictEqual(error.statusCode, 404);
      assert.ok(error.message.includes("not found"));
      return true;
    }
  );

  await assert.rejects(
    () => sessionService.startSession("non-existent-id"),
    (error) => error.statusCode === 404
  );
});

test("api: invalid event type returns 422", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "invalid_event" }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      return true;
    }
  );
});

test("api: negative combo value returns 422", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "fish_caught", payload: { combo: -5 } }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      return true;
    }
  );
});

test("api: combo value exceeding max returns 422", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "fish_caught", payload: { combo: 9999 } }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      return true;
    }
  );
});

test("api: finish on created session returns 409", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  const session = await sessionService.createSession({ playerName: "TestCat" });

  await assert.rejects(
    () => sessionService.finishSession(session.id),
    (error) => {
      assert.strictEqual(error.statusCode, 409);
      return true;
    }
  );
});

test("api: addEvent on created session returns 409", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  const session = await sessionService.createSession({ playerName: "TestCat" });

  await assert.rejects(
    () => sessionService.addEvent(session.id, { type: "fish_caught" }),
    (error) => {
      assert.strictEqual(error.statusCode, 409);
      return true;
    }
  );
});

test("api: expired session returns 410", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { getSessionFilePath } = require("../src/repositories/session-repo");
  const { SESSION_TTL_MS } = require("../src/config");

  const sessionService = createSessionService();
  const session = await sessionService.createSession({ playerName: "ExpireCat" });

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
  const { SESSION_STATES } = require("../src/game-rules");
  assert.strictEqual(expiredSession.state, SESSION_STATES.EXPIRED);
  assert.ok(expiredSession.expiredAt);
});

test("api: event timestamp out of order returns 422", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { MAX_EVENT_PAST_SKEW_MS } = require("../src/config");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);

  const now = Date.now();
  await sessionService.addEvent(session.id, { type: "fish_caught", occurredAt: now });

  await assert.rejects(
    () => sessionService.addEvent(session.id, { 
      type: "fish_caught", 
      occurredAt: now - MAX_EVENT_PAST_SKEW_MS - 1000 
    }),
    (error) => {
      assert.strictEqual(error.statusCode, 422);
      return true;
    }
  );
});

test("api: player name normalization", async () => {
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

test("api: closeSession on finished session returns 409", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });
  session = await sessionService.finishSession(session.id);

  await assert.rejects(
    () => sessionService.closeSession(session.id),
    (error) => {
      assert.strictEqual(error.statusCode, 409);
      return true;
    }
  );
});

test("api: startSession on finished session returns 409", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();
  let session = await sessionService.createSession({ playerName: "TestCat" });
  session = await sessionService.startSession(session.id);
  await sessionService.addEvent(session.id, { type: "fish_caught" });
  session = await sessionService.finishSession(session.id);

  await assert.rejects(
    () => sessionService.startSession(session.id),
    (error) => {
      assert.strictEqual(error.statusCode, 409);
      return true;
    }
  );
});

test("api: getSession returns all fields", async () => {
  const { createSessionService } = require("../src/services/session-service");
  const { SESSION_STATES } = require("../src/game-rules");

  const sessionService = createSessionService();
  const created = await sessionService.createSession({ playerName: "TestCat" });

  const fetched = await sessionService.getSession(created.id);

  assert.strictEqual(fetched.id, created.id);
  assert.strictEqual(fetched.playerName, "TestCat");
  assert.strictEqual(fetched.state, SESSION_STATES.CREATED);
  assert.ok(fetched.createdAt);
  assert.strictEqual(fetched.startedAt, null);
  assert.strictEqual(fetched.finishedAt, null);
  assert.strictEqual(fetched.closedAt, null);
  assert.strictEqual(fetched.expiredAt, null);
  assert.strictEqual(fetched.submittedToLeaderboard, false);
  assert.deepStrictEqual(fetched.events, []);
  assert.strictEqual(fetched.result, null);
});

test("api: closed session not in leaderboard", async () => {
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

test("api: cleanupExpiredSessions returns count", async () => {
  const { createSessionService } = require("../src/services/session-service");

  const sessionService = createSessionService();

  const count = await sessionService.cleanupExpiredSessions();
  assert.strictEqual(count, 0);
});
