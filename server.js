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
const MAX_NAME_LENGTH = 20;

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
  await fsp.writeFile(SCORES_FILE, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
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
      title: "Cat Snack Dash",
      durationSeconds: 45,
      maxLives: 3,
      fishScore: 10,
      goldenFishScore: 25,
      bombPenalty: 1
    });
  }

  if (req.method === "POST" && url.pathname === "/api/score") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const name = normalizeName(body.name);
      const score = normalizeScore(body.score);

      const scores = await readScores();
      scores.push({
        name,
        score,
        createdAt: new Date().toISOString()
      });

      await writeScores(scores);
      return sendJson(res, 201, {
        ok: true,
        leaderboard: buildLeaderboard(scores)
      });
    } catch (error) {
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
    console.log(`Cat Snack Dash is running at http://${HOST}:${PORT}`);
  });
}

createServer();
