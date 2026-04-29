const path = require("path");
const fsp = require("fs/promises");
const zlib = require("zlib");
const { promisify } = require("util");
const readline = require("readline");
const fs = require("fs");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const {
  BACKUP_DIR,
  SESSION_DIR,
  LEADERBOARD_FILE,
  EVENTS_LOG_FILE,
  EXPORT_REPORTS_DIR,
  EXPORT_STATE_FILE,
  EXPORT_TEMP_DIR,
  EXPORT_HISTORY_DIR,
  EXPORT_EVENT_LOG,
  EXPORT_OUTPUT_DIR,
  IMPORT_REPORTS_DIR,
  IMPORT_STATE_FILE,
  IMPORT_TEMP_DIR,
  IMPORT_HISTORY_DIR,
  IMPORT_EVENT_LOG,
  IMPORT_INPUT_DIR,
  OPERATION_DEFAULT_MAX_RETRIES,
  OPERATION_DEFAULT_RETRY_DELAY_MS,
  OPERATION_DEFAULT_TIMEOUT_MS,
  OPERATION_DEFAULT_MAX_CONCURRENCY,
  OPERATION_AUTO_ROLLBACK,
  OPERATION_PERSIST_EVENTS
} = require("../config");
const { ensureDir, readJson, writeJsonAtomic, listJsonFiles, appendLine } = require("../utils/file-store");
const { createId } = require("../utils/id");
const { createOperationManager, OPERATION_STATES, OPERATION_EVENT_TYPES } = require("./operation-manager");

const EXPORT_IMPORT_STATES = OPERATION_STATES;
const EXPORT_IMPORT_EVENT_TYPES = OPERATION_EVENT_TYPES;
const EXPORT_OPERATION_TYPE = "export";
const IMPORT_OPERATION_TYPE = "import";

const EXPORT_FORMAT_VERSION = "1.1";

const MERGE_STRATEGIES = {
  SKIP_EXISTING: "skip_existing",
  OVERWRITE: "overwrite",
  MERGE: "merge"
};

const EXPORT_FILE_SIZE_LIMIT = 100 * 1024 * 1024;
const EVENT_BATCH_SIZE = 1000;

const exportOperationManager = createOperationManager({
  operationName: "export",
  backupDir: EXPORT_TEMP_DIR,
  reportsDir: EXPORT_REPORTS_DIR,
  stateFile: EXPORT_STATE_FILE,
  tempDir: EXPORT_TEMP_DIR,
  historyDir: EXPORT_HISTORY_DIR,
  eventLogFile: EXPORT_EVENT_LOG,
  transactionModeEnabled: false,
  trackedResources: [],
  defaultConfig: {
    maxRetries: OPERATION_DEFAULT_MAX_RETRIES,
    retryDelayMs: OPERATION_DEFAULT_RETRY_DELAY_MS,
    timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
    concurrencyKey: "export",
    maxConcurrency: OPERATION_DEFAULT_MAX_CONCURRENCY,
    autoRollbackOnFailure: false,
    persistEvents: OPERATION_PERSIST_EVENTS
  }
});

const importOperationManager = createOperationManager({
  operationName: "import",
  backupDir: BACKUP_DIR,
  reportsDir: IMPORT_REPORTS_DIR,
  stateFile: IMPORT_STATE_FILE,
  tempDir: IMPORT_TEMP_DIR,
  historyDir: IMPORT_HISTORY_DIR,
  eventLogFile: IMPORT_EVENT_LOG,
  transactionModeEnabled: true,
  trackedResources: [
    {
      key: "sessions",
      type: "directory",
      targetPath: SESSION_DIR,
      backupPath: "sessions"
    },
    {
      key: "events_log",
      type: "file",
      targetPath: EVENTS_LOG_FILE,
      backupPath: "events.log"
    },
    {
      key: "leaderboard",
      type: "file",
      targetPath: LEADERBOARD_FILE,
      backupPath: "leaderboard.json"
    }
  ],
  defaultConfig: {
    maxRetries: OPERATION_DEFAULT_MAX_RETRIES,
    retryDelayMs: OPERATION_DEFAULT_RETRY_DELAY_MS,
    timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
    concurrencyKey: "import",
    maxConcurrency: OPERATION_DEFAULT_MAX_CONCURRENCY,
    autoRollbackOnFailure: OPERATION_AUTO_ROLLBACK,
    persistEvents: OPERATION_PERSIST_EVENTS
  }
});

function generateTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function generateExportId() {
  const timestamp = generateTimestamp();
  const shortId = createId("exp").slice(-8);
  return `catrank-export-${timestamp}-${shortId}`;
}

async function ensureExportImportDirs() {
  await ensureDir(EXPORT_OUTPUT_DIR);
  await ensureDir(IMPORT_INPUT_DIR);
  await ensureDir(EXPORT_TEMP_DIR);
  await ensureDir(IMPORT_TEMP_DIR);
  await ensureDir(EXPORT_REPORTS_DIR);
  await ensureDir(IMPORT_REPORTS_DIR);
  await ensureDir(EXPORT_HISTORY_DIR);
  await ensureDir(IMPORT_HISTORY_DIR);
}

async function copyDirectory(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    await ensureDir(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function readAllSessions(options = {}) {
  const { isInterrupted = null } = options;
  const sessionFiles = await listJsonFiles(SESSION_DIR);
  const sessions = [];

  for (const filePath of sessionFiles) {
    if (isInterrupted && isInterrupted()) {
      throw new Error("Operation cancelled");
    }
    
    try {
      const session = await readJson(filePath, null);
      if (session) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }

  return sessions;
}

async function readLeaderboard(options = {}) {
  const { isInterrupted = null } = options;
  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }
  return readJson(LEADERBOARD_FILE, []);
}

async function countEventLogLines() {
  try {
    const content = await fsp.readFile(EVENTS_LOG_FILE, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());
    return lines.length;
  } catch {
    return 0;
  }
}

async function readEventLogAsArray(options = {}) {
  const { isInterrupted = null, limit = null } = options;
  const events = [];
  
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(EVENTS_LOG_FILE, { encoding: "utf-8" }),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    for await (const line of rl) {
      if (isInterrupted && isInterrupted()) {
        rl.close();
        throw new Error("Operation cancelled");
      }
      
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        events.push(event);
        lineCount++;
        
        if (limit !== null && lineCount >= limit) {
          break;
        }
      } catch {
        continue;
      }
    }
    
    rl.close();
  } catch (error) {
    if (error.message === "Operation cancelled") {
      throw error;
    }
  }

  return events;
}

async function getExistingEventIds() {
  const ids = new Set();
  
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(EVENTS_LOG_FILE, { encoding: "utf-8" }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        if (event.id) {
          ids.add(event.id);
        }
      } catch {
        continue;
      }
    }
    
    rl.close();
  } catch {
  }

  return ids;
}

async function readImportHistory() {
  const historyFiles = await listJsonFiles(IMPORT_HISTORY_DIR);
  const history = [];

  for (const filePath of historyFiles) {
    try {
      const record = await readJson(filePath, null);
      if (record && record.manifest && record.manifest.id) {
        history.push({
          exportId: record.manifest.id,
          importId: record.id,
          importedAt: record.completedAt || record.createdAt,
          mergeStrategy: record.mergeStrategy
        });
      }
    } catch {
      continue;
    }
  }

  return history;
}

async function checkDuplicateImport(exportId) {
  const history = await readImportHistory();
  return history.find(h => h.exportId === exportId);
}

async function createExportArchive(exportDir, outputPath, compress = true) {
  const archive = {
    manifest: null,
    files: {}
  };

  const manifestPath = path.join(exportDir, "manifest.json");
  archive.manifest = await readJson(manifestPath, null);

  async function collectFiles(dir, baseDir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      
      if (entry.isDirectory()) {
        await collectFiles(fullPath, baseDir);
      } else {
        const content = await fsp.readFile(fullPath, "utf-8");
        archive.files[relativePath] = content;
      }
    }
  }
  
  await collectFiles(exportDir, exportDir);

  const jsonContent = JSON.stringify(archive);
  
  if (compress) {
    const compressed = await gzip(Buffer.from(jsonContent, "utf-8"));
    await fsp.writeFile(outputPath, compressed);
  } else {
    await fsp.writeFile(outputPath, jsonContent, "utf-8");
  }

  return { success: true };
}

async function extractExportArchive(sourcePath, extractDir, isInterrupted = null) {
  const stats = await fsp.stat(sourcePath);
  
  if (stats.isDirectory()) {
    await copyDirectory(sourcePath, extractDir);
    const manifestPath = path.join(extractDir, "manifest.json");
    const manifest = await readJson(manifestPath, null);
    return { success: true, manifest };
  }

  let archive;
  const content = await fsp.readFile(sourcePath);
  
  try {
    const decompressed = await gunzip(content);
    archive = JSON.parse(decompressed.toString("utf-8"));
  } catch (e1) {
    try {
      archive = JSON.parse(content.toString("utf-8"));
    } catch (e2) {
      throw new Error("Invalid export package format");
    }
  }

  if (!archive || !archive.manifest) {
    throw new Error("Export package missing manifest");
  }

  for (const [relativePath, fileContent] of Object.entries(archive.files || {})) {
    if (isInterrupted && isInterrupted()) {
      throw new Error("Operation cancelled");
    }
    
    const targetPath = path.join(extractDir, relativePath);
    await ensureDir(path.dirname(targetPath));
    await fsp.writeFile(targetPath, fileContent, "utf-8");
  }

  const manifestPath = path.join(extractDir, "manifest.json");
  await writeJsonAtomic(manifestPath, archive.manifest);

  return { success: true, manifest: archive.manifest };
}

async function createExportPackage(options = {}) {
  const {
    includeSessions = true,
    includeLeaderboard = true,
    includeEventLog = true,
    compress = true,
    metadata = {},
    isInterrupted = null,
    progress = null
  } = options;

  await ensureExportImportDirs();

  if (progress) progress({ phase: "preparing", percent: 5, message: "Initializing export..." });

  const exportId = generateExportId();
  const exportDir = path.join(EXPORT_TEMP_DIR, exportId);
  await ensureDir(exportDir);

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  const manifest = {
    id: exportId,
    version: EXPORT_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    includes: {
      sessions: includeSessions,
      leaderboard: includeLeaderboard,
      eventLog: includeEventLog
    },
    metadata: {
      ...metadata,
      exportId
    },
    sessionCount: 0,
    leaderboardEntryCount: 0,
    eventCount: 0
  };

  if (includeSessions) {
    if (progress) progress({ phase: "sessions", percent: 15, message: "Reading sessions..." });
    
    const sessions = await readAllSessions({ isInterrupted });
    manifest.sessionCount = sessions.length;

    if (sessions.length > 0) {
      const sessionsDir = path.join(exportDir, "sessions");
      await ensureDir(sessionsDir);

      for (let i = 0; i < sessions.length; i++) {
        if (isInterrupted && isInterrupted()) {
          throw new Error("Operation cancelled");
        }
        
        const session = sessions[i];
        const sessionPath = path.join(sessionsDir, `${session.id}.json`);
        await writeJsonAtomic(sessionPath, session);
        
        if (progress && i % 100 === 0) {
          progress({ 
            phase: "sessions", 
            percent: 15 + Math.floor((i / sessions.length) * 20), 
            message: `Writing session ${i + 1} of ${sessions.length}...` 
          });
        }
      }
    }
  }

  if (includeLeaderboard) {
    if (progress) progress({ phase: "leaderboard", percent: 40, message: "Reading leaderboard..." });
    
    const leaderboard = await readLeaderboard({ isInterrupted });
    manifest.leaderboardEntryCount = leaderboard.length;

    if (leaderboard.length > 0) {
      if (isInterrupted && isInterrupted()) {
        throw new Error("Operation cancelled");
      }
      
      const leaderboardPath = path.join(exportDir, "leaderboard.json");
      await writeJsonAtomic(leaderboardPath, leaderboard);
    }
  }

  if (includeEventLog) {
    if (progress) progress({ phase: "events", percent: 50, message: "Reading event log..." });
    
    const eventCount = await countEventLogLines();
    manifest.eventCount = eventCount;

    if (eventCount > 0) {
      if (isInterrupted && isInterrupted()) {
        throw new Error("Operation cancelled");
      }
      
      const events = await readEventLogAsArray({ isInterrupted });
      const eventsPath = path.join(exportDir, "events.json");
      await writeJsonAtomic(eventsPath, events);
    }
  }

  if (progress) progress({ phase: "archiving", percent: 80, message: "Creating export package..." });

  const manifestPath = path.join(exportDir, "manifest.json");
  await writeJsonAtomic(manifestPath, manifest);

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  const extension = compress ? ".json.gz" : ".json";
  const outputPath = path.join(EXPORT_OUTPUT_DIR, `${exportId}${extension}`);
  await createExportArchive(exportDir, outputPath, compress);

  await fsp.rm(exportDir, { recursive: true, force: true });

  if (progress) progress({ phase: "completed", percent: 100, message: "Export completed" });

  const outputStats = await fsp.stat(outputPath);

  return {
    success: true,
    exportId,
    outputPath,
    compressed: compress,
    fileSize: outputStats.size,
    manifest
  };
}

async function listExports() {
  await ensureExportImportDirs();

  try {
    const files = await fsp.readdir(EXPORT_OUTPUT_DIR);
    const exports = [];

    for (const file of files) {
      try {
        const filePath = path.join(EXPORT_OUTPUT_DIR, file);
        const stats = await fsp.stat(filePath);
        
        const isCompressed = file.endsWith(".json.gz");
        const isUncompressed = file.endsWith(".json") && !file.endsWith(".json.gz");
        
        if (!isCompressed && !isUncompressed) {
          continue;
        }

        let manifest = null;
        if (stats.size < EXPORT_FILE_SIZE_LIMIT) {
          try {
            const content = await fsp.readFile(filePath);
            let archive;
            
            if (isCompressed) {
              const decompressed = await gunzip(content);
              archive = JSON.parse(decompressed.toString("utf-8"));
            } else {
              archive = JSON.parse(content.toString("utf-8"));
            }
            
            manifest = archive.manifest;
          } catch {
            manifest = null;
          }
        }

        exports.push({
          id: file.replace(/\.json\.gz$/, "").replace(/\.json$/, ""),
          name: file,
          path: filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          isCompressed,
          manifest
        });
      } catch {
        continue;
      }
    }

    exports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      success: true,
      exports,
      count: exports.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      exports: [],
      count: 0
    };
  }
}

async function getExportInfo(exportId) {
  await ensureExportImportDirs();

  const possiblePaths = [
    path.join(EXPORT_OUTPUT_DIR, `${exportId}.json.gz`),
    path.join(EXPORT_OUTPUT_DIR, `${exportId}.json`)
  ];

  for (const filePath of possiblePaths) {
    try {
      const stats = await fsp.stat(filePath);
      const isCompressed = filePath.endsWith(".json.gz");
      
      let manifest = null;
      if (stats.size < EXPORT_FILE_SIZE_LIMIT) {
        try {
          const content = await fsp.readFile(filePath);
          let archive;
          
          if (isCompressed) {
            const decompressed = await gunzip(content);
            archive = JSON.parse(decompressed.toString("utf-8"));
          } else {
            archive = JSON.parse(content.toString("utf-8"));
          }
          
          manifest = archive.manifest;
        } catch {
          manifest = null;
        }
      }

      return {
        success: true,
        exportId,
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        isCompressed,
        manifest
      };
    } catch {
      continue;
    }
  }

  return {
    success: false,
    error: "Export not found",
    exportId
  };
}

async function deleteExport(exportId) {
  const info = await getExportInfo(exportId);
  if (!info.success) {
    return { success: false, error: "Export not found", exportId };
  }

  try {
    await fsp.rm(info.path, { recursive: true, force: true });
    return { success: true, exportId };
  } catch (error) {
    return { success: false, error: error.message, exportId };
  }
}

async function extractImportPackage(importSource, options = {}) {
  const { isInterrupted = null, progress = null } = options;
  
  await ensureExportImportDirs();

  if (progress) progress({ phase: "extracting", percent: 5, message: "Locating import package..." });

  const importId = `import_${generateTimestamp()}_${createId("imp")}`;
  const extractDir = path.join(IMPORT_TEMP_DIR, importId);
  await ensureDir(extractDir);

  let sourcePath = importSource;
  if (!path.isAbsolute(importSource)) {
    sourcePath = path.join(IMPORT_INPUT_DIR, importSource);
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  try {
    await fsp.access(sourcePath);
  } catch {
    throw new Error(`Import package not found: ${sourcePath}`);
  }

  if (progress) progress({ phase: "extracting", percent: 10, message: "Extracting package contents..." });

  const result = await extractExportArchive(sourcePath, extractDir, isInterrupted);

  if (!result.manifest) {
    const manifestPath = path.join(extractDir, "manifest.json");
    result.manifest = await readJson(manifestPath, null);
  }

  return {
    success: true,
    importId,
    extractDir,
    manifest: result.manifest,
    sourcePath
  };
}

async function validateImportPackage(extractDir, manifest, options = {}) {
  const {
    validateSessions = true,
    validateLeaderboard = true,
    validateEventLog = true,
    isInterrupted = null
  } = options;

  const issues = [];
  const warnings = [];
  const details = {
    sessions: { valid: 0, invalid: 0, corrupted: 0 },
    leaderboard: { valid: true, error: null },
    events: { valid: 0, invalid: 0 }
  };

  if (!manifest) {
    issues.push({ 
      type: "missing_manifest", 
      severity: "error",
      message: "Import package is missing manifest.json",
      recoverable: false
    });
    return { valid: false, issues, warnings, details, manifest };
  }

  if (!manifest.id) {
    issues.push({ 
      type: "invalid_manifest", 
      severity: "error",
      message: "Manifest missing required 'id' field",
      recoverable: false
    });
  }

  if (manifest.version !== EXPORT_FORMAT_VERSION) {
    const [major, minor] = (manifest.version || "0.0").split(".").map(Number);
    const [currentMajor, currentMinor] = EXPORT_FORMAT_VERSION.split(".").map(Number);
    
    if (major > currentMajor) {
      issues.push({
        type: "version_incompatible",
        severity: "error",
        message: `Import package version ${manifest.version} is newer than current version ${EXPORT_FORMAT_VERSION}`,
        recoverable: false
      });
    } else if (major < currentMajor || minor < currentMinor) {
      warnings.push({
        type: "version_mismatch",
        severity: "warning",
        message: `Import package version ${manifest.version} may have different format than current version ${EXPORT_FORMAT_VERSION}`
      });
    }
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (validateSessions && manifest.includes?.sessions) {
    const sessionsDir = path.join(extractDir, "sessions");
    
    try {
      const sessionFiles = await listJsonFiles(sessionsDir);
      
      if (sessionFiles.length !== manifest.sessionCount) {
        warnings.push({
          type: "session_count_mismatch",
          severity: "warning",
          message: `Manifest reports ${manifest.sessionCount} sessions but found ${sessionFiles.length} files`
        });
      }

      for (const sessionPath of sessionFiles) {
        if (isInterrupted && isInterrupted()) {
          throw new Error("Operation cancelled");
        }
        
        try {
          const session = await readJson(sessionPath, null);
          
          if (!session) {
            details.sessions.invalid++;
            issues.push({
              type: "invalid_session",
              severity: "error",
              file: path.basename(sessionPath),
              message: `Session file is empty or invalid: ${path.basename(sessionPath)}`,
              recoverable: true
            });
          } else if (!session.id) {
            details.sessions.invalid++;
            issues.push({
              type: "invalid_session",
              severity: "error",
              file: path.basename(sessionPath),
              message: `Session missing 'id' field: ${path.basename(sessionPath)}`,
              recoverable: true
            });
          } else {
            details.sessions.valid++;
          }
        } catch (error) {
          details.sessions.corrupted++;
          issues.push({
            type: "corrupted_session",
            severity: "error",
            file: path.basename(sessionPath),
            message: `Corrupted session file: ${path.basename(sessionPath)} - ${error.message}`,
            recoverable: true
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        issues.push({
          type: "sessions_read_error",
          severity: "error",
          message: `Failed to read sessions directory: ${error.message}`,
          recoverable: false
        });
      }
    }
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (validateLeaderboard && manifest.includes?.leaderboard) {
    const leaderboardPath = path.join(extractDir, "leaderboard.json");
    
    try {
      const leaderboard = await readJson(leaderboardPath, null);
      
      if (leaderboard !== null) {
        if (!Array.isArray(leaderboard)) {
          details.leaderboard.valid = false;
          details.leaderboard.error = "not_an_array";
          issues.push({
            type: "invalid_leaderboard",
            severity: "error",
            message: "Leaderboard is not an array",
            recoverable: true
          });
        } else {
          for (let i = 0; i < leaderboard.length; i++) {
            const entry = leaderboard[i];
            if (!entry.sessionId) {
              issues.push({
                type: "invalid_leaderboard_entry",
                severity: "warning",
                index: i,
                message: `Leaderboard entry ${i} missing 'sessionId' field`
              });
            }
            if (entry.score === undefined || entry.score === null) {
              issues.push({
                type: "invalid_leaderboard_entry",
                severity: "warning",
                index: i,
                message: `Leaderboard entry ${i} missing 'score' field`
              });
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        details.leaderboard.valid = false;
        details.leaderboard.error = error.message;
        issues.push({
          type: "leaderboard_read_error",
          severity: "error",
          message: `Failed to read leaderboard: ${error.message}`,
          recoverable: true
        });
      }
    }
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (validateEventLog && manifest.includes?.eventLog) {
    const eventsPath = path.join(extractDir, "events.json");
    
    try {
      const events = await readJson(eventsPath, null);
      
      if (events !== null) {
        if (!Array.isArray(events)) {
          issues.push({
            type: "invalid_events",
            severity: "error",
            message: "Event log is not an array",
            recoverable: true
          });
        } else {
          const eventIds = new Set();
          for (let i = 0; i < events.length; i++) {
            if (isInterrupted && isInterrupted()) {
              throw new Error("Operation cancelled");
            }
            
            const event = events[i];
            if (!event.id) {
              details.events.invalid++;
              warnings.push({
                type: "event_missing_id",
                severity: "warning",
                index: i,
                message: `Event ${i} missing 'id' field`
              });
            } else {
              if (eventIds.has(event.id)) {
                warnings.push({
                  type: "duplicate_event_id",
                  severity: "warning",
                  eventId: event.id,
                  message: `Duplicate event ID: ${event.id}`
                });
              }
              eventIds.add(event.id);
              details.events.valid++;
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        issues.push({
          type: "events_read_error",
          severity: "error",
          message: `Failed to read events: ${error.message}`,
          recoverable: true
        });
      }
    }
  }

  const fatalErrors = issues.filter(i => i.severity === "error" && !i.recoverable);

  return {
    valid: fatalErrors.length === 0,
    hasRecoverableErrors: issues.filter(i => i.severity === "error" && i.recoverable).length > 0,
    issues,
    warnings,
    details,
    manifest
  };
}

function applySessionMergeStrategy(existingSession, importSession, mergeStrategy) {
  if (!existingSession) {
    return { action: "import", session: importSession };
  }

  switch (mergeStrategy) {
    case MERGE_STRATEGIES.SKIP_EXISTING:
      return { action: "skip", reason: "already_exists" };
      
    case MERGE_STRATEGIES.OVERWRITE:
      return { action: "overwrite", session: importSession };
      
    case MERGE_STRATEGIES.MERGE:
      const existingUpdated = existingSession.updatedAt || existingSession.closedAt || existingSession.finishedAt || existingSession.createdAt;
      const importUpdated = importSession.updatedAt || importSession.closedAt || importSession.finishedAt || importSession.createdAt;
      
      if (new Date(importUpdated) > new Date(existingUpdated)) {
        return { action: "overwrite", session: importSession, reason: "newer_version" };
      } else {
        return { action: "skip", reason: "existing_is_newer" };
      }
      
    default:
      return { action: "skip", reason: "unknown_strategy" };
  }
}

function applyLeaderboardMergeStrategy(existingEntries, importEntry, mergeStrategy) {
  const existingEntry = existingEntries.find(e => e.sessionId === importEntry.sessionId);

  if (!existingEntry) {
    return { action: "add", entry: importEntry };
  }

  switch (mergeStrategy) {
    case MERGE_STRATEGIES.SKIP_EXISTING:
      return { action: "skip", reason: "already_exists" };
      
    case MERGE_STRATEGIES.OVERWRITE:
      return { action: "replace", entry: importEntry, index: existingEntries.indexOf(existingEntry) };
      
    case MERGE_STRATEGIES.MERGE:
      if (importEntry.score > existingEntry.score) {
        return { action: "replace", entry: importEntry, index: existingEntries.indexOf(existingEntry), reason: "higher_score" };
      } else {
        return { action: "skip", reason: "existing_score_higher_or_equal" };
      }
      
    default:
      return { action: "skip", reason: "unknown_strategy" };
  }
}

function applyEventMergeStrategy(existingEventIds, importEvent, mergeStrategy) {
  const eventId = importEvent.id;
  const exists = existingEventIds.has(eventId);

  if (!exists) {
    return { action: "add", event: importEvent };
  }

  switch (mergeStrategy) {
    case MERGE_STRATEGIES.SKIP_EXISTING:
      return { action: "skip", reason: "already_exists" };
      
    case MERGE_STRATEGIES.OVERWRITE:
      return { action: "skip", reason: "event_log_append_only" };
      
    case MERGE_STRATEGIES.MERGE:
      return { action: "skip", reason: "already_exists" };
      
    default:
      return { action: "skip", reason: "unknown_strategy" };
  }
}

async function executeImport(extractDir, manifest, options = {}) {
  const {
    importSessions = true,
    importLeaderboard = true,
    importEventLog = true,
    mergeStrategy = MERGE_STRATEGIES.SKIP_EXISTING,
    dryRun = true,
    progress = null,
    isInterrupted = null
  } = options;

  const result = {
    success: true,
    dryRun,
    mergeStrategy,
    sessions: {
      imported: 0,
      skipped: 0,
      overwritten: 0,
      failed: 0,
      total: 0
    },
    leaderboard: {
      imported: 0,
      skipped: 0,
      overwritten: 0,
      failed: 0,
      total: 0
    },
    events: {
      imported: 0,
      skipped: 0,
      failed: 0,
      total: 0
    },
    warnings: [],
    actions: []
  };

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (importSessions && manifest.includes?.sessions) {
    const sessionsDir = path.join(extractDir, "sessions");
    
    try {
      const sessionFiles = await listJsonFiles(sessionsDir);
      result.sessions.total = sessionFiles.length;

      for (let i = 0; i < sessionFiles.length; i++) {
        if (isInterrupted && isInterrupted()) {
          throw new Error("Operation cancelled");
        }
        
        const sessionPath = sessionFiles[i];

        try {
          const importSession = await readJson(sessionPath, null);
          if (!importSession || !importSession.id) {
            result.sessions.failed++;
            result.warnings.push({
              type: "session_skipped",
              file: path.basename(sessionPath),
              reason: "invalid_session"
            });
            continue;
          }

          const targetPath = path.join(SESSION_DIR, `${importSession.id}.json`);
          const existingSession = await readJson(targetPath, null);

          const mergeResult = applySessionMergeStrategy(existingSession, importSession, mergeStrategy);
          
          result.actions.push({
            type: "session",
            id: importSession.id,
            action: mergeResult.action,
            reason: mergeResult.reason
          });

          if (mergeResult.action === "skip") {
            result.sessions.skipped++;
            result.warnings.push({
              type: "session_skipped",
              sessionId: importSession.id,
              reason: mergeResult.reason
            });
          } else if (!dryRun) {
            await ensureDir(SESSION_DIR);
            await writeJsonAtomic(targetPath, mergeResult.session);
            
            if (mergeResult.action === "overwrite") {
              result.sessions.overwritten++;
            } else {
              result.sessions.imported++;
            }
          } else {
            if (mergeResult.action === "overwrite") {
              result.sessions.overwritten++;
            } else {
              result.sessions.imported++;
            }
          }

        } catch (error) {
          result.sessions.failed++;
          result.warnings.push({
            type: "session_import_failed",
            file: path.basename(sessionPath),
            error: error.message
          });
        }

        if (progress) {
          progress({
            phase: "importing_sessions",
            percent: Math.floor((i + 1) / sessionFiles.length * 30) + 10,
            message: `Importing session ${i + 1} of ${sessionFiles.length}...`
          });
        }
      }
    } catch (error) {
      if (error.message === "Operation cancelled") {
        throw error;
      }
      if (error.code !== "ENOENT") {
        result.sessions.failed = manifest.sessionCount || 0;
        result.warnings.push({
          type: "sessions_import_error",
          error: error.message
        });
      }
    }
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (importLeaderboard && manifest.includes?.leaderboard) {
    const leaderboardPath = path.join(extractDir, "leaderboard.json");

    try {
      const importLeaderboardData = await readJson(leaderboardPath, []);
      if (!Array.isArray(importLeaderboardData)) {
        result.leaderboard.failed = 1;
        result.warnings.push({
          type: "leaderboard_invalid",
          reason: "not_an_array"
        });
      } else {
        result.leaderboard.total = importLeaderboardData.length;

        if (progress) {
          progress({
            phase: "importing_leaderboard",
            percent: 50,
            message: "Importing leaderboard entries..."
          });
        }

        if (!dryRun) {
          if (mergeStrategy === MERGE_STRATEGIES.OVERWRITE) {
            await ensureDir(path.dirname(LEADERBOARD_FILE));
            await writeJsonAtomic(LEADERBOARD_FILE, importLeaderboardData);
            result.leaderboard.imported = importLeaderboardData.length;
            result.actions.push({ type: "leaderboard", action: "replace_all" });
          } else {
            const currentLeaderboard = await readJson(LEADERBOARD_FILE, []);
            const updatedLeaderboard = [...currentLeaderboard];

            for (const entry of importLeaderboardData) {
              if (isInterrupted && isInterrupted()) {
                throw new Error("Operation cancelled");
              }
              
              if (!entry.sessionId) {
                result.leaderboard.skipped++;
                result.warnings.push({
                  type: "leaderboard_entry_skipped",
                  reason: "missing_sessionId"
                });
                continue;
              }

              const mergeResult = applyLeaderboardMergeStrategy(updatedLeaderboard, entry, mergeStrategy);
              
              result.actions.push({
                type: "leaderboard_entry",
                sessionId: entry.sessionId,
                action: mergeResult.action,
                reason: mergeResult.reason
              });

              if (mergeResult.action === "skip") {
                result.leaderboard.skipped++;
              } else if (mergeResult.action === "add") {
                updatedLeaderboard.push(mergeResult.entry);
                result.leaderboard.imported++;
              } else if (mergeResult.action === "replace") {
                updatedLeaderboard[mergeResult.index] = mergeResult.entry;
                result.leaderboard.overwritten++;
              }
            }

            await ensureDir(path.dirname(LEADERBOARD_FILE));
            await writeJsonAtomic(LEADERBOARD_FILE, updatedLeaderboard);
          }
        } else {
          result.leaderboard.imported = importLeaderboardData.length;
        }
      }
    } catch (error) {
      if (error.message === "Operation cancelled") {
        throw error;
      }
      if (error.code !== "ENOENT") {
        result.leaderboard.failed = 1;
        result.warnings.push({
          type: "leaderboard_import_error",
          error: error.message
        });
      }
    }
  }

  if (isInterrupted && isInterrupted()) {
    throw new Error("Operation cancelled");
  }

  if (importEventLog && manifest.includes?.eventLog) {
    const eventsPath = path.join(extractDir, "events.json");

    try {
      const importEvents = await readJson(eventsPath, []);
      if (!Array.isArray(importEvents)) {
        result.events.failed = 1;
        result.warnings.push({
          type: "events_invalid",
          reason: "not_an_array"
        });
      } else {
        result.events.total = importEvents.length;

        if (progress) {
          progress({
            phase: "importing_events",
            percent: 75,
            message: "Importing event log..."
          });
        }

        if (mergeStrategy === MERGE_STRATEGIES.OVERWRITE) {
          if (!dryRun) {
            await ensureDir(path.dirname(EVENTS_LOG_FILE));
            await fsp.writeFile(EVENTS_LOG_FILE, "", "utf-8");
            
            for (let i = 0; i < importEvents.length; i += EVENT_BATCH_SIZE) {
              if (isInterrupted && isInterrupted()) {
                throw new Error("Operation cancelled");
              }
              
              const batch = importEvents.slice(i, i + EVENT_BATCH_SIZE);
              for (const event of batch) {
                try {
                  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
                  result.events.imported++;
                } catch {
                  result.events.failed++;
                }
              }
            }
            result.actions.push({ type: "event_log", action: "overwrite" });
          } else {
            result.events.imported = importEvents.length;
          }
        } else {
          let existingEventIds = new Set();
          if (!dryRun) {
            existingEventIds = await getExistingEventIds();
          }

          if (!dryRun) {
            for (const event of importEvents) {
              if (isInterrupted && isInterrupted()) {
                throw new Error("Operation cancelled");
              }
              
              const mergeResult = applyEventMergeStrategy(existingEventIds, event, mergeStrategy);
              
              if (event.id) {
                result.actions.push({
                  type: "event",
                  id: event.id,
                  action: mergeResult.action,
                  reason: mergeResult.reason
                });
              }

              if (mergeResult.action === "skip") {
                result.events.skipped++;
              } else if (mergeResult.action === "add") {
                try {
                  await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
                  result.events.imported++;
                  if (event.id) {
                    existingEventIds.add(event.id);
                  }
                } catch {
                  result.events.failed++;
                }
              }
            }
          } else {
            result.events.imported = importEvents.length;
          }
        }
      }
    } catch (error) {
      if (error.message === "Operation cancelled") {
        throw error;
      }
      if (error.code !== "ENOENT") {
        result.events.failed = 1;
        result.warnings.push({
          type: "events_import_error",
          error: error.message
        });
      }
    }
  }

  if (progress) {
    progress({
      phase: "completed",
      percent: 100,
      message: "Import completed"
    });
  }

  return result;
}

async function listImports() {
  await ensureExportImportDirs();

  try {
    const files = await fsp.readdir(IMPORT_INPUT_DIR);
    const imports = [];

    for (const file of files) {
      try {
        const filePath = path.join(IMPORT_INPUT_DIR, file);
        const stats = await fsp.stat(filePath);
        
        const isCompressed = file.endsWith(".json.gz");
        const isUncompressed = file.endsWith(".json") && !file.endsWith(".json.gz");
        const isDirectory = stats.isDirectory();
        
        if (!isCompressed && !isUncompressed && !isDirectory) {
          continue;
        }

        imports.push({
          id: file.replace(/\.json\.gz$/, "").replace(/\.json$/, ""),
          name: file,
          path: filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          isCompressed,
          isDirectory
        });
      } catch {
        continue;
      }
    }

    imports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      success: true,
      imports,
      count: imports.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      imports: [],
      count: 0
    };
  }
}

async function registerExportOperation() {
  if (exportOperationManager.getRegisteredOperation(EXPORT_OPERATION_TYPE)) {
    return;
  }

  exportOperationManager.registerOperation({
    type: EXPORT_OPERATION_TYPE,
    handler: async ({ operation, progress, isInterrupted }) => {
      const options = {
        includeSessions: operation.metadata?.includeSessions !== false,
        includeLeaderboard: operation.metadata?.includeLeaderboard !== false,
        includeEventLog: operation.metadata?.includeEventLog !== false,
        compress: operation.metadata?.compress !== false,
        metadata: operation.metadata || {},
        isInterrupted,
        progress
      };

      progress({
        phase: "starting",
        percent: 0,
        message: "Starting export operation..."
      });

      const result = await createExportPackage(options);

      return result;
    },
    config: {
      maxRetries: 0,
      timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
      concurrencyKey: "export",
      maxConcurrency: 1
    }
  });
}

async function registerImportOperation() {
  if (importOperationManager.getRegisteredOperation(IMPORT_OPERATION_TYPE)) {
    return;
  }

  importOperationManager.registerOperation({
    type: IMPORT_OPERATION_TYPE,
    handler: async ({ operation, progress, isInterrupted }) => {
      const source = operation.metadata?.source;
      if (!source) {
        throw new Error("Import source is required");
      }

      if (isInterrupted && isInterrupted()) {
        throw new Error("Operation cancelled");
      }

      progress({
        phase: "checking_duplicate",
        percent: 2,
        message: "Checking for duplicate imports..."
      });

      let tempManifest = null;
      try {
        const extractResult = await extractImportPackage(source, { isInterrupted, progress });
        tempManifest = extractResult.manifest;
        await fsp.rm(extractResult.extractDir, { recursive: true, force: true });
      } catch (e) {
      }

      if (tempManifest && tempManifest.id) {
        const duplicate = await checkDuplicateImport(tempManifest.id);
        if (duplicate && !operation.metadata?.allowDuplicateImport) {
          throw new Error(`This export package has already been imported on ${duplicate.importedAt}`);
        }
      }

      progress({
        phase: "extracting",
        percent: 5,
        message: "Extracting import package..."
      });

      const extractResult = await extractImportPackage(source, { isInterrupted, progress });

      if (isInterrupted && isInterrupted()) {
        await fsp.rm(extractResult.extractDir, { recursive: true, force: true });
        throw new Error("Operation cancelled");
      }

      progress({
        phase: "validating",
        percent: 20,
        message: "Validating import package..."
      });

      const validation = await validateImportPackage(
        extractResult.extractDir,
        extractResult.manifest,
        {
          validateSessions: operation.metadata?.importSessions !== false,
          validateLeaderboard: operation.metadata?.importLeaderboard !== false,
          validateEventLog: operation.metadata?.importEventLog !== false,
          isInterrupted
        }
      );

      if (!validation.valid && !operation.metadata?.ignoreValidationErrors) {
        await fsp.rm(extractResult.extractDir, { recursive: true, force: true });
        
        const fatalErrors = validation.issues.filter(i => i.severity === "error" && !i.recoverable);
        throw new Error(`Import validation failed: ${fatalErrors.map(i => i.message).join(", ")}`);
      }

      if (isInterrupted && isInterrupted()) {
        await fsp.rm(extractResult.extractDir, { recursive: true, force: true });
        throw new Error("Operation cancelled");
      }

      progress({
        phase: "importing",
        percent: 30,
        message: "Starting import..."
      });

      const result = await executeImport(
        extractResult.extractDir,
        extractResult.manifest,
        {
          importSessions: operation.metadata?.importSessions !== false,
          importLeaderboard: operation.metadata?.importLeaderboard !== false,
          importEventLog: operation.metadata?.importEventLog !== false,
          mergeStrategy: operation.metadata?.mergeStrategy || MERGE_STRATEGIES.SKIP_EXISTING,
          dryRun: operation.dryRun,
          progress,
          isInterrupted
        }
      );

      result.validation = validation;
      result.importId = extractResult.importId;
      result.manifest = extractResult.manifest;
      result.duplicateCheck = {
        exportId: tempManifest?.id,
        wasDuplicate: tempManifest ? !!await checkDuplicateImport(tempManifest.id) : false
      };

      await fsp.rm(extractResult.extractDir, { recursive: true, force: true });

      return result;
    },
    rollbackHandler: async ({ operation, backupResult, progress }) => {
      if (!backupResult || !backupResult.success) {
        return { success: false, reason: "no_backup" };
      }

      progress({
        phase: "rolling_back",
        percent: 50,
        message: "Rolling back import..."
      });

      const result = await importOperationManager.restoreFromBackup(backupResult.backupId);
      return result;
    },
    config: {
      maxRetries: 0,
      timeoutMs: OPERATION_DEFAULT_TIMEOUT_MS,
      concurrencyKey: "import",
      maxConcurrency: 1
    }
  });
}

async function runExportOperation(options = {}) {
  await registerExportOperation();

  return exportOperationManager.runOperation(EXPORT_OPERATION_TYPE, {
    dryRun: options.dryRun !== false,
    metadata: options.metadata || {}
  });
}

async function runImportOperation(options = {}) {
  await registerImportOperation();

  return importOperationManager.runOperation(IMPORT_OPERATION_TYPE, {
    dryRun: options.dryRun !== false,
    metadata: options.metadata || {}
  });
}

registerExportOperation().catch(() => {});
registerImportOperation().catch(() => {});

module.exports = {
  EXPORT_IMPORT_STATES,
  EXPORT_IMPORT_EVENT_TYPES,
  EXPORT_OPERATION_TYPE,
  IMPORT_OPERATION_TYPE,
  EXPORT_FORMAT_VERSION,
  MERGE_STRATEGIES,
  registerExportOperation,
  registerImportOperation,
  ensureExportImportDirs,
  createExportPackage,
  listExports,
  getExportInfo,
  deleteExport,
  extractImportPackage,
  validateImportPackage,
  executeImport,
  listImports,
  runExportOperation,
  runImportOperation,
  getExportOperation: exportOperationManager.getOperation,
  getImportOperation: importOperationManager.getOperation,
  listActiveExportOperations: exportOperationManager.listActiveOperations,
  listActiveImportOperations: importOperationManager.listActiveOperations,
  cancelExportOperation: exportOperationManager.cancelOperation,
  cancelImportOperation: importOperationManager.cancelOperation,
  listExportHistory: exportOperationManager.listOperationHistory,
  listImportHistory: importOperationManager.listOperationHistory,
  getExportHistory: exportOperationManager.getOperationHistory,
  getImportHistory: importOperationManager.getOperationHistory,
  readExportEvents: exportOperationManager.readOperationEvents,
  readImportEvents: importOperationManager.readOperationEvents,
  onExportEvent: exportOperationManager.onOperationEvent,
  onImportEvent: importOperationManager.onOperationEvent,
  getExportState: exportOperationManager.getCurrentOperationState,
  getImportState: importOperationManager.getCurrentOperationState,
  loadExportState: exportOperationManager.loadOperationState,
  loadImportState: importOperationManager.loadOperationState,
  getExportProgress: exportOperationManager.getCurrentProgress,
  getImportProgress: importOperationManager.getCurrentProgress,
  listExportBackups: exportOperationManager.listBackups,
  listImportBackups: importOperationManager.listBackups,
  restoreFromImportBackup: importOperationManager.restoreFromBackup,
  checkDuplicateImport,
  readImportHistory
};
