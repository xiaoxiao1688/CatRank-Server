const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4321);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const LOCK_FILE = path.join(DATA_DIR, ".scores.lock");
const MAX_NAME_LENGTH = 20;

const LOCK_TIMEOUT_MS = 5000;
const LOCK_WAIT_INTERVAL_MS = 100;
const LOCK_STALE_MS = 30000;
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MIN_SESSION_AGE_MS = 5000;
const MAX_SESSION_AGE_MS = 5 * 60 * 1000;
const BASE_SCORE_FISH = 10;
const BASE_SCORE_GOLDEN = 25;
const BASE_SCORE_ENEMY_MIN = 15;
const BASE_SCORE_BOMB_CLEARED = 5;
const MAX_BOMBS_POSSIBLE = 50;
const MAX_ENEMIES_POSSIBLE = 30;
const MAX_BOMBS_CLEARED_POSSIBLE = 20;

const GAME_CONFIG = {
  title: "Cat Snack Dash",
  durationSeconds: 90,
  maxLives: 3,
  fishScore: 10,
  goldenFishScore: 25,
  bombPenalty: 1,
  baseSpawnInterval: 800,
  minSpawnInterval: 300,
  maxItemsPerSecond: 4,
  maxComboMultiplier: 2,
  doubleScoreMultiplier: 2,
  powerUps: {
    shield: { name: "Shield", duration: 5000, icon: "SH" },
    doubleScore: { name: "Double", duration: 8000, icon: "X2" },
    magnet: { name: "Magnet", duration: 6000, icon: "MG" },
    slowTime: { name: "Slow", duration: 5000, icon: "SL" }
  },
  skills: {
    dash: { name: "Dash", cooldown: 10000, icon: "D" },
    clearBombs: { name: "Clear", cooldown: 15000, icon: "C" }
  }
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const activeSessions = new Map();

function log(level, message, error) {
  const prefix = `[${new Date().toISOString()}] [${level}]`;
  if (error) {
    console.error(prefix, message, error);
    return;
  }

  if (level === "WARN") {
    console.warn(prefix, message);
    return;
  }

  console.log(prefix, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(SCORES_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(SCORES_FILE, "[]\n", "utf8");
  }

  await clearStaleLockIfNeeded();
}

async function clearStaleLockIfNeeded() {
  try {
    const raw = await fsp.readFile(LOCK_FILE, "utf8");
    const createdAt = Number(raw.trim());
    if (!Number.isFinite(createdAt)) {
      await fsp.unlink(LOCK_FILE);
      return;
    }

    if (Date.now() - createdAt > LOCK_STALE_MS) {
      log("WARN", "Removing stale score lock");
      await fsp.unlink(LOCK_FILE);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("WARN", "Failed to inspect score lock", error);
    }
  }
}

async function acquireLock() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fsp.open(LOCK_FILE, "wx");
      try {
        await handle.writeFile(`${Date.now()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      await clearStaleLockIfNeeded();
      await delay(LOCK_WAIT_INTERVAL_MS);
    }
  }

  return false;
}

async function releaseLock() {
  try {
    await fsp.unlink(LOCK_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("WARN", "Failed to release score lock", error);
    }
  }
}

async function readScores() {
  try {
    const raw = await fsp.readFile(SCORES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    log("ERROR", "Failed to read scores", error);
    return [];
  }
}

async function writeScores(scores) {
  const tempPath = `${SCORES_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
  
  try {
    await fsp.rename(tempPath, SCORES_FILE);
  } catch (renameError) {
    if (renameError.code === "EPERM" || renameError.code === "EEXIST") {
      try {
        await fsp.copyFile(tempPath, SCORES_FILE, fs.constants.COPYFILE_FICLONE_FORCE);
        await fsp.unlink(tempPath);
      } catch (copyError) {
        try {
          await fsp.unlink(tempPath);
        } catch (e) {}
        throw copyError;
      }
    } else {
      try {
        await fsp.unlink(tempPath);
      } catch (e) {}
      throw renameError;
    }
  }
}

async function addScoreAtomically(newEntry) {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    throw new Error("Failed to acquire score lock");
  }

  try {
    const scores = await readScores();
    scores.push(newEntry);
    await writeScores(scores);
    return scores;
  } finally {
    await releaseLock();
  }
}

function normalizeName(value) {
  if (typeof value !== "string") {
    return "Guest Cat";
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return (trimmed || "Guest Cat").slice(0, MAX_NAME_LENGTH);
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.round(numeric));
}

function calculateMaxPossibleScore() {
  const maxItems = GAME_CONFIG.durationSeconds * GAME_CONFIG.maxItemsPerSecond;
  const maxPerItem =
    GAME_CONFIG.goldenFishScore *
    GAME_CONFIG.maxComboMultiplier *
    GAME_CONFIG.doubleScoreMultiplier;

  return Math.floor(maxItems * maxPerItem);
}

function createSession() {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const now = Date.now();

  const session = {
    id: sessionId,
    createdAt: now,
    startedAt: now,
    lastActivityAt: now,
    analytics: {
      itemsCaught: { fish: 0, golden: 0, bomb: 0 },
      enemiesDefeated: 0,
      bombsCleared: 0,
      powerUpsUsed: 0
    }
  };

  activeSessions.set(sessionId, session);
  return session;
}

function closeSession(sessionId) {
  if (!sessionId) {
    return;
  }

  activeSessions.delete(sessionId);
}

function touchSession(session) {
  if (session) {
    session.lastActivityAt = Date.now();
  }
}

function cleanExpiredSessions() {
  const now = Date.now();
  let removed = 0;

  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      activeSessions.delete(sessionId);
      removed += 1;
    }
  }

  if (removed > 0) {
    log("INFO", `Cleaned ${removed} expired sessions`);
  }
}

function validateScore(score, session) {
  if (!session) {
    return { valid: false, reason: "Session not found" };
  }

  if (score < 0) {
    return { valid: false, reason: "Score cannot be negative" };
  }

  if (score === 0) {
    return { valid: false, reason: "Score must be greater than 0" };
  }

  const maxPossibleScore = calculateMaxPossibleScore();
  if (score > maxPossibleScore) {
    return {
      valid: false,
      reason: `Score exceeds max possible value (${score} > ${maxPossibleScore})`
    };
  }

  const ageMs = Date.now() - session.startedAt;
  if (ageMs < MIN_SESSION_AGE_MS) {
    return {
      valid: false,
      reason: `Session ended too quickly (${Math.round(ageMs / 1000)}s < ${MIN_SESSION_AGE_MS / 1000}s)`
    };
  }

  if (ageMs > MAX_SESSION_AGE_MS) {
    return {
      valid: false,
      reason: `Session expired (${Math.round(ageMs / 1000)}s > ${MAX_SESSION_AGE_MS / 1000}s)`
    };
  }

  const analytics = session.analytics || {};
  const items = analytics.itemsCaught || { fish: 0, golden: 0, bomb: 0 };
  const enemiesDefeated = analytics.enemiesDefeated || 0;
  const bombsCleared = analytics.bombsCleared || 0;

  const totalItems = items.fish + items.golden + items.bomb;
  const hasAnyActivity = totalItems > 0 || enemiesDefeated > 0;

  if (score > 0 && !hasAnyActivity) {
    log("WARN", `Score ${score} submitted but no activity tracked`);
  }

  const minBaseScore = 
    items.fish * BASE_SCORE_FISH + 
    items.golden * BASE_SCORE_GOLDEN +
    enemiesDefeated * BASE_SCORE_ENEMY_MIN +
    bombsCleared * BASE_SCORE_BOMB_CLEARED;

  if (hasAnyActivity && score < minBaseScore * 0.5) {
    return {
      valid: false,
      reason: `Score too low for tracked activity (${score} < ${minBaseScore})`
    };
  }

  const durationSeconds = Math.min(ageMs / 1000, GAME_CONFIG.durationSeconds);
  const maxItemsPerSecond = GAME_CONFIG.maxItemsPerSecond;
  const maxPossibleItems = Math.floor(durationSeconds * maxItemsPerSecond * 1.5);

  if (totalItems > maxPossibleItems + 20) {
    return {
      valid: false,
      reason: `Too many items collected (${totalItems} > ${maxPossibleItems})`
    };
  }

  if (items.bomb > MAX_BOMBS_POSSIBLE) {
    return {
      valid: false,
      reason: `Too many bombs caught (${items.bomb} > ${MAX_BOMBS_POSSIBLE})`
    };
  }

  if (enemiesDefeated > MAX_ENEMIES_POSSIBLE) {
    return {
      valid: false,
      reason: `Too many enemies defeated (${enemiesDefeated} > ${MAX_ENEMIES_POSSIBLE})`
    };
  }

  if (bombsCleared > MAX_BOMBS_CLEARED_POSSIBLE) {
    return {
      valid: false,
      reason: `Too many bombs cleared (${bombsCleared} > ${MAX_BOMBS_CLEARED_POSSIBLE})`
    };
  }

  const activityDurationMs = session.lastActivityAt - session.startedAt;
  if (activityDurationMs < durationSeconds * 0.3 && activityDurationMs > 0 && score > 100) {
    log("WARN", `Suspicious activity: score ${score} but only ${activityDurationMs}ms activity in ${durationSeconds}s game`);
  }

  return { valid: true };
}

function buildLeaderboard(scores) {
  return [...scores]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })
    .slice(0, 10)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      score: entry.score,
      createdAt: entry.createdAt
    }));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const scores = await readScores();
    return sendJson(res, 200, { leaderboard: buildLeaderboard(scores) });
  }

  if (req.method === "GET" && url.pathname === "/api/game-config") {
    return sendJson(res, 200, {
      ...GAME_CONFIG,
      maxPossibleScore: calculateMaxPossibleScore()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const session = createSession();
    return sendJson(res, 201, { ok: true, sessionId: session.id });
  }

  if (req.method === "POST" && url.pathname === "/api/session/update") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const session = activeSessions.get(body.sessionId);

      if (!session) {
        return sendJson(res, 400, { ok: false, message: "Invalid session" });
      }

      touchSession(session);

      if (body.updateType === "itemCaught" && session.analytics.itemsCaught[body.itemType] !== undefined) {
        session.analytics.itemsCaught[body.itemType] += 1;
      }

      if (body.updateType === "enemyDefeated") {
        session.analytics.enemiesDefeated += 1;
      }

      if (body.updateType === "bombsCleared") {
        session.analytics.bombsCleared += body.count || 1;
      }

      if (body.updateType === "powerUpUsed") {
        session.analytics.powerUpsUsed += 1;
      }

      return sendJson(res, 200, { ok: true });
    } catch (error) {
      log("ERROR", "Failed to update session analytics", error);
      return sendJson(res, 400, { ok: false, message: "Invalid session payload" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/session/close") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      closeSession(body.sessionId);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: "Invalid close payload" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/score") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const name = normalizeName(body.name);
      const score = normalizeScore(body.score);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const session = activeSessions.get(sessionId);
      const validation = validateScore(score, session);

      if (!validation.valid) {
        closeSession(sessionId);
        return sendJson(res, 422, {
          ok: false,
          message: validation.reason
        });
      }

      const newEntry = {
        name,
        score,
        createdAt: new Date().toISOString()
      };

      const scores = await addScoreAtomically(newEntry);
      closeSession(sessionId);

      return sendJson(res, 201, {
        ok: true,
        score,
        leaderboard: buildLeaderboard(scores)
      });
    } catch (error) {
      log("ERROR", "Failed to submit score", error);
      return sendJson(res, 400, {
        ok: false,
        message: "Invalid score payload"
      });
    }
  }

  return false;
}

function safePathname(pathname) {
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return normalized === path.sep ? "index.html" : normalized.replace(/^[/\\]/, "") || "index.html";
}

async function serveStatic(res, url) {
  const targetPath = safePathname(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.join(PUBLIC_DIR, targetPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const ext = path.extname(finalPath).toLowerCase();
    const data = await fsp.readFile(finalPath);

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function createServer() {
  await ensureStorage();
  setInterval(cleanExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    try {
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (handled !== false) {
          return;
        }
      }

      await serveStatic(res, url);
    } catch (error) {
      log("ERROR", "Unhandled request failure", error);
      sendJson(res, 500, {
        ok: false,
        message: "Internal server error"
      });
    }
  });

  server.listen(PORT, HOST, () => {
    log("INFO", `Cat Snack Dash is running at http://${HOST}:${PORT}`);
  });
}

createServer();
