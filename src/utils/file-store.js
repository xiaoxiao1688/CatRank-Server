const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function ensureFile(filePath, initialContent) {
  await ensureDir(path.dirname(filePath));

  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(filePath, initialContent, "utf8");
  }
}

async function ensureJsonFile(filePath, defaultValue) {
  await ensureFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`);
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    if (error instanceof SyntaxError) {
      return fallbackValue;
    }
    throw error;
  }
}

async function readJsonSafe(filePath, fallbackValue) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return {
      ok: true,
      data: JSON.parse(raw)
    };
  } catch (error) {
    return {
      ok: false,
      error: error,
      errorCode: error.code || "UNKNOWN",
      isSyntaxError: error instanceof SyntaxError,
      isNotFound: error.code === "ENOENT",
      data: fallbackValue
    };
  }
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, `${line}\n`, "utf8");
}

async function readLinesSafe(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content.split("\n");
    const validLines = [];
    const invalidLineNumbers = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) {
        try {
          JSON.parse(line);
          validLines.push({
            lineNumber: i + 1,
            raw: line
          });
        } catch {
          invalidLineNumbers.push(i + 1);
        }
      }
    }

    return {
      ok: true,
      validLines,
      invalidLineNumbers,
      hasCorruption: invalidLineNumbers.length > 0
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: true,
        validLines: [],
        invalidLineNumbers: [],
        hasCorruption: false,
        isNotFound: true
      };
    }
    return {
      ok: false,
      error,
      validLines: [],
      invalidLineNumbers: [],
      hasCorruption: true
    };
  }
}

async function listJsonFiles(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function listSessionsSafe(sessionDir) {
  const files = await listJsonFiles(sessionDir);
  const validSessions = [];
  const corruptedFiles = [];

  for (const filePath of files) {
    const result = await readJsonSafe(filePath, null);
    if (result.ok && result.data !== null) {
      validSessions.push({
        filePath,
        data: result.data
      });
    } else {
      corruptedFiles.push({
        filePath,
        error: result.error,
        isSyntaxError: result.isSyntaxError
      });
    }
  }

  return {
    validSessions,
    corruptedFiles,
    hasCorruption: corruptedFiles.length > 0
  };
}

module.exports = {
  ensureDir,
  ensureFile,
  ensureJsonFile,
  readJson,
  readJsonSafe,
  writeJsonAtomic,
  appendLine,
  readLinesSafe,
  listJsonFiles,
  listSessionsSafe
};
