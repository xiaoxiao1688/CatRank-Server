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
const LOCK_STALE_THRESHOLD = 30000;
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL = 10 * 60 * 1000;

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
  maxItemsPerSecond: 4,
  maxComboMultiplier: 2.0,
  doubleScoreDuration: 8000
};

const activeSessions = new Map();

function logInfo(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logWarn(message) {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] ⚠️  ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ❌ ${message}`, error || "");
}

async function acquireLock() {
  const startTime = Date.now();
  let lockAcquired = false;

  while (Date.now() - startTime < LOCK_TIMEOUT && !lockAcquired) {
    try {
      await fsp.access(LOCK_FILE, fs.constants.F_OK);
      
      try {
        const lockContent = await fsp.readFile(LOCK_FILE, "utf8");
        const lockTime = Number(lockContent.trim());
        const now = Date.now();
        
        if (!Number.isNaN(lockTime) && (now - lockTime) > LOCK_STALE_THRESHOLD) {
          logWarn(`检测到死锁文件，强制清理（锁时间: ${new Date(lockTime).toISOString()}）`);
          await fsp.unlink(LOCK_FILE);
          continue;
        }
      } catch (readError) {
        try {
          await fsp.unlink(LOCK_FILE);
          continue;
        } catch {
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_INTERVAL));
    } catch {
      try {
        const now = Date.now();
        await fsp.writeFile(LOCK_FILE, `${now}\n`, "utf8");
        lockAcquired = true;
      } catch (writeError) {
        await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_INTERVAL));
      }
    }
  }

  return lockAcquired;
}

async function releaseLock() {
  try {
    await fsp.unlink(LOCK_FILE);
  } catch (error) {
    logWarn("释放锁文件失败:", error);
  }
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(SCORES_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(SCORES_FILE, "[]\n", "utf8");
    logInfo("创建新的分数存储文件");
  }

  try {
    await fsp.access(LOCK_FILE, fs.constants.F_OK);
    const lockContent = await fsp.readFile(LOCK_FILE, "utf8");
    const lockTime = Number(lockContent.trim());
    const now = Date.now();
    
    if (Number.isNaN(lockTime) || (now - lockTime) > LOCK_STALE_THRESHOLD) {
      logWarn("启动时检测到残留锁文件，已清理");
      await fsp.unlink(LOCK_FILE);
    }
  } catch {
  }
}

async function readScores() {
  try {
    const raw = await fsp.readFile(SCORES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    logError("读取分数文件失败", error);
    return [];
  }
}

async function writeScores(scores) {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    logError("无法获取文件锁，写入失败");
    throw new Error("Failed to acquire lock for writing scores");
  }
  
  try {
    const tempFile = `${SCORES_FILE}.tmp.${Date.now()}`;
    await fsp.writeFile(tempFile, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
    await fsp.rename(tempFile, SCORES_FILE);
    logInfo(`分数已保存，共 ${scores.length} 条记录`);
  } finally {
    await releaseLock();
  }
}

function cleanExpiredSessions() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, session] of activeSessions.entries()) {
    const sessionAge = now - session.createdAt;
    if (sessionAge > SESSION_TIMEOUT) {
      activeSessions.delete(sessionId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logInfo(`清理了 ${cleanedCount} 个过期会话`);
  }
}

function startSessionCleanup() {
  setInterval(() => {
    cleanExpiredSessions();
  }, SESSION_CLEANUP_INTERVAL);
  
  logInfo(`会话清理任务已启动，间隔 ${SESSION_CLEANUP_INTERVAL / 1000} 秒`);
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
  const duration = GAME_CONFIG.durationSeconds;
  const maxItems = duration * GAME_CONFIG.maxItemsPerSecond;
  
  const baseMaxPerItem = GAME_CONFIG.goldenFishScore;
  const comboMultiplier = GAME_CONFIG.maxComboMultiplier;
  const doubleScoreMultiplier = 2;
  
  return Math.floor(maxItems * baseMaxPerItem * comboMultiplier * doubleScoreMultiplier);
}

function validateScore(score, sessionData) {
  const maxPossibleScore = calculateMaxPossibleScore();
  
  if (score > maxPossibleScore) {
    return { 
      valid: false, 
      reason: `分数超过理论最大值 (${score} > ${maxPossibleScore})` 
    };
  }

  if (score < 0) {
    return { valid: false, reason: "分数为负数" };
  }

  if (!sessionData) {
    return { 
      valid: false, 
      reason: "无活动会话",
      allowSave: true
    };
  }

  if (sessionData.itemsCaught) {
    const baseScore = 
      (sessionData.itemsCaught.fish || 0) * GAME_CONFIG.fishScore +
      (sessionData.itemsCaught.golden || 0) * GAME_CONFIG.goldenFishScore;
    
    const tolerance = Math.max(100, baseScore * 0.5);
    
    if (score < 0) {
      return { valid: false, reason: "分数为负数" };
    }
    
    if (score > baseScore + tolerance + 1000) {
      return { 
        valid: false, 
        reason: `分数与捕获物品不匹配 (上报: ${score}, 基础: ${baseScore}, 容差: ${tolerance})` 
      };
    }
  }

  return { 
    valid: true, 
    adjustedScore: score,
    reason: "校验通过"
  };
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
      powerUpsUsed: 0,
      clientStartTime: null
    });

    logInfo(`创建新会话: ${sessionId}`);

    return sendJson(res, 200, {
      ...GAME_CONFIG,
      sessionId,
      maxPossibleScore: calculateMaxPossibleScore(),
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
        return sendJson(res, 400, { ok: false, message: "无效的会话" });
      }

      const session = activeSessions.get(sessionId);
      
      if (body.updateType === "itemCaught") {
        const itemType = body.itemType;
        if (session.itemsCaught[itemType] !== undefined) {
          session.itemsCaught[itemType]++;
        }
      } else if (body.updateType === "powerUpUsed") {
        session.powerUpsUsed++;
      } else if (body.updateType === "gameStart") {
        session.clientStartTime = Date.now();
      }

      return sendJson(res, 200, { ok: true });
    } catch (error) {
      logError("会话更新失败", error);
      return sendJson(res, 400, { ok: false, message: "无效的更新数据" });
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
        logWarn(`分数校验失败: ${validation.reason}, 玩家: ${name}, 分数: ${score}`);
      } else {
        logInfo(`分数校验通过: 玩家 ${name}, 分数 ${score}`);
      }

      const finalScore = score;

      const scores = await readScores();
      scores.push({
        name,
        score: finalScore,
        createdAt: new Date().toISOString(),
        validated: validation.valid,
        validationReason: validation.reason,
        sessionStats: sessionData ? {
          fish: sessionData.itemsCaught.fish,
          golden: sessionData.itemsCaught.golden,
          bomb: sessionData.itemsCaught.bomb,
          powerUpsUsed: sessionData.powerUpsUsed
        } : null
      });

      await writeScores(scores);

      if (sessionId) {
        activeSessions.delete(sessionId);
        logInfo(`会话已结束: ${sessionId}`);
      }

      return sendJson(res, 201, {
        ok: true,
        score: finalScore,
        validated: validation.valid,
        validationReason: validation.reason,
        leaderboard: buildLeaderboard(scores)
      });
    } catch (error) {
      logError("分数提交失败", error);
      return sendJson(res, 400, {
        ok: false,
        message: "无效的分数数据"
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
  startSessionCleanup();

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
      logError("请求处理失败", error);
      sendJson(res, 500, {
        ok: false,
        message: "服务器内部错误"
      });
    }
  });

  server.listen(PORT, HOST, () => {
    logInfo(`🐱 猫咪冲刺食堂运行在 http://${HOST}:${PORT}`);
    logInfo(`📊 最大可能分数: ${calculateMaxPossibleScore()}`);
    logInfo(`⏱️  会话超时: ${SESSION_TIMEOUT / 1000} 秒`);
  });
}

createServer();
