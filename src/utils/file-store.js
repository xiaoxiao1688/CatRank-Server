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

    throw error;
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

module.exports = {
  ensureDir,
  ensureFile,
  ensureJsonFile,
  readJson,
  writeJsonAtomic,
  appendLine,
  listJsonFiles
};
