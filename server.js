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
const LOCK_FILE = path.join(DATA_DIR, ".write.lock");
const MAX_NAME_LENGTH = 20;
const LOCK_TIMEOUT = 5000;
const LOCK_WAIT_INTERVAL = 100;

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

const GAME_CONFIG = {
  title: "猫咪冲刺食堂",
  durationSeconds: 60,
  maxLives: 3,
  fishScore: 10,
  goldenFishScore: 25,
  bombPenalty: 1,
  baseSpawnInterval: 800,
  minSpawnInterval: 300,
  maxItemsPerSecond: 4
};

const activeSessions = new Map();

async function acquireLock() {
  const startTime = Date.now();
  while (Date.now() - startTime < LOCK_TIMEOUT) {
    try {
      await fsp.access(LOCK_FILE, fs.constants.F_OK);
      await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_INTERVAL));
    } catch {
      try {
        await fsp.writeFile(LOCK_FILE, `${Date.now()}\n`, "utf8");
        return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_INTERVAL));
      }
    }
  }
  return false;
}

async function releaseLock() {
  try {
    await fsp.unlink(LOCK_FILE);
  } catch {
  }
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(SCORES_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(SCORES_FILE, "[]\n", "utf8");
  }
}

async function readScores() {
  try {
    const raw = await fsp.readFile(SCORES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeScores(scores) {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    throw new Error("Failed to acquire lock for writing scores");
  }
  
  try {
    await fsp.writeFile(SCORES_FILE, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
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

function validateScore(score, sessionData) {
  if (!sessionData) {
    return { valid: false, reason: "No active session" };
  }

  const maxFishScore = GAME_CONFIG.fishScore;
  const maxGoldenScore = GAME_CONFIG.goldenFishScore;
  
  const duration = GAME_CONFIG.durationSeconds;
  const maxItems = duration * GAME_CONFIG.maxItemsPerSecond;
  
  const maxPossibleScore = maxItems * maxGoldenScore;
  const minReasonableScore = 0;

  if (score > maxPossibleScore) {
    return { valid: false, reason: "Score exceeds maximum possible" };
  }

  if (score < minReasonableScore) {
    return { valid: false, reason: "Score is negative" };
  }

  if (sessionData.itemsCaught) {
    const calculatedScore = 
      (sessionData.itemsCaught.fish || 0) * maxFishScore +
      (sessionData.itemsCaught.golden || 0) * maxGoldenScore;
    
    if (Math.abs(score - calculatedScore) > 50) {
      return { valid: false, reason: "Score mismatch with caught items" };
    }
  }

  return { valid: true, adjustedScore: score };
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

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const scores = await readScores();
    return sendJson(res, 200, { leaderboard: buildLeaderboard(scores) });
  }

  if (req.method === "GET" && url.pathname === "/api/game-config") {
    const sessionId = generateSessionId();
    activeSessions.set(sessionId, {
      createdAt: Date.now(),
      itemsCaught: { fish: 0, golden: 0, bomb: 0 },
      powerUpsUsed: 0
    });

    return sendJson(res, 200, {
      ...GAME_CONFIG,
      sessionId,
      powerUps: {
        shield: { name: "护盾", duration: 5000, icon: "🛡️" },
        doubleScore: { name: "双倍分数", duration: 8000, icon: "✨" },
        magnet: { name: "磁铁", duration: 6000, icon: "🧲" },
        slowTime: { name: "时间减缓", duration: 5000, icon: "⏰" }
      },
      skills: {
        dash: { name: "冲刺", cooldown: 10000, icon: "💨" },
        clearBombs: { name: "清屏", cooldown: 15000, icon: "💥" }
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session-update") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const sessionId = body.sessionId;
      
      if (!sessionId || !activeSessions.has(sessionId)) {
        return sendJson(res, 400, { ok: false, message: "Invalid session" });
      }

      const session = activeSessions.get(sessionId);
      
      if (body.updateType === "itemCaught") {
        const itemType = body.itemType;
        if (session.itemsCaught[itemType] !== undefined) {
          session.itemsCaught[itemType]++;
        }
      } else if (body.updateType === "powerUpUsed") {
        session.powerUpsUsed++;
      }

      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: "Invalid update payload" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/score") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const name = normalizeName(body.name);
      const score = normalizeScore(body.score);
      const sessionId = body.sessionId;

      const sessionData = activeSessions.get(sessionId);
      const validation = validateScore(score, sessionData);

      if (!validation.valid) {
        console.warn(`Score validation failed: ${validation.reason}, score: ${score}`);
      }

      const finalScore = validation.valid ? validation.adjustedScore : Math.min(score, 500);

      const scores = await readScores();
      scores.push({
        name,
        score: finalScore,
        createdAt: new Date().toISOString(),
        validated: validation.valid
      });

      await writeScores(scores);

      if (sessionId) {
        activeSessions.delete(sessionId);
      }

      return sendJson(res, 201, {
        ok: true,
        score: finalScore,
        validated: validation.valid,
        leaderboard: buildLeaderboard(scores)
      });
    } catch (error) {
      console.error("Score submission error:", error);
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

async function serveStatic(req, res, url) {
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    try {
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (handled !== false) {
          return;
        }
      }

      await serveStatic(req, res, url);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, {
        ok: false,
        message: "Internal server error"
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`🐱 猫咪冲刺食堂运行在 http://${HOST}:${PORT}`);
  });
}

createServer();
