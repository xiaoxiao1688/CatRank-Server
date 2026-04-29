const path = require("path");
const fsp = require("fs/promises");
const zlib = require("zlib");
const { promisify } = require("util");

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
const { ensureDir, readJson, writeJsonAtomic, listJsonFiles } = require("../utils/file-store");
const { createId } = require("../utils/id");
const { createOperationManager, OPERATION_STATES, OPERATION_EVENT_TYPES } = require("./operation-manager");

const EXPORT_IMPORT_STATES = OPERATION_STATES;
const EXPORT_IMPORT_EVENT_TYPES = OPERATION_EVENT_TYPES;
const EXPORT_OPERATION_TYPE = "export";
const IMPORT_OPERATION_TYPE = "import";

const EXPORT_FORMAT_VERSION = "1.0";

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
  return new Date().toISOString().replace(/[:.]/g, "-");
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

async function readAllSessions() {
  const sessionFiles = await listJsonFiles(SESSION_DIR);
  const sessions = [];

  for (const filePath of sessionFiles) {
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

async function readLeaderboard() {
  return readJson(LEADERBOARD_FILE, []);
}

async function readEventLog() {
  try {
    const content = await fsp.readFile(EVENTS_LOG_FILE, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());
    const events = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }

    return events;
  } catch {
    return [];
  }
}

async function createExportPackage(options = {}) {
  const {
    includeSessions = true,
    includeLeaderboard = true,
    includeEventLog = true,
    compress = true,
    metadata = {}
  } = options;

  await ensureExportImportDirs();

  const exportId = `export_${generateTimestamp()}_${createId("exp")}`;
  const exportDir = path.join(EXPORT_TEMP_DIR, exportId);
  await ensureDir(exportDir);

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

  let sessionCount = 0;
  if (includeSessions) {
    const sessions = await readAllSessions();
    sessionCount = sessions.length;

    if (sessions.length > 0) {
      const sessionsDir = path.join(exportDir, "sessions");
      await ensureDir(sessionsDir);

      for (const session of sessions) {
        const sessionPath = path.join(sessionsDir, `${session.id}.json`);
        await writeJsonAtomic(sessionPath, session);
      }
    }
    manifest.sessionCount = sessionCount;
  }

  let leaderboardEntryCount = 0;
  if (includeLeaderboard) {
    const leaderboard = await readLeaderboard();
    leaderboardEntryCount = leaderboard.length;

    if (leaderboard.length > 0) {
      const leaderboardPath = path.join(exportDir, "leaderboard.json");
      await writeJsonAtomic(leaderboardPath, leaderboard);
    }
    manifest.leaderboardEntryCount = leaderboardEntryCount;
  }

  let eventCount = 0;
  if (includeEventLog) {
    const events = await readEventLog();
    eventCount = events.length;

    if (events.length > 0) {
      const eventsPath = path.join(exportDir, "events.json");
      await writeJsonAtomic(eventsPath, events);
    }
    manifest.eventCount = eventCount;
  }

  const manifestPath = path.join(exportDir, "manifest.json");
  await writeJsonAtomic(manifestPath, manifest);

  let outputPath;
  let isCompressed = false;

  if (compress) {
    const tempTarPath = path.join(EXPORT_TEMP_DIR, `${exportId}.tar`);
    
    const filesToCompress = [];
    async function collectFiles(dir, baseDir) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        if (entry.isDirectory()) {
          await collectFiles(fullPath, baseDir);
        } else {
          filesToCompress.push({ relativePath, fullPath });
        }
      }
    }
    await collectFiles(exportDir, exportDir);

    const archive = {
      manifest,
      files: {}
    };

    for (const file of filesToCompress) {
      const content = await fsp.readFile(file.fullPath, "utf-8");
      archive.files[file.relativePath] = content;
    }

    const jsonContent = JSON.stringify(archive);
    const compressed = await gzip(Buffer.from(jsonContent, "utf-8"));
    
    outputPath = path.join(EXPORT_OUTPUT_DIR, `${exportId}.tar.gz`);
    await fsp.writeFile(outputPath, compressed);
    isCompressed = true;

  } else {
    outputPath = path.join(EXPORT_OUTPUT_DIR, exportId);
    await copyDirectory(exportDir, outputPath);
  }

  await fsp.rm(exportDir, { recursive: true, force: true });

  return {
    success: true,
    exportId,
    outputPath,
    compressed: isCompressed,
    manifest: {
      ...manifest,
      fileSize: (await fsp.stat(outputPath)).size
    }
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

        exports.push({
          id: file.replace(/\.tar\.gz$/, ""),
          name: file,
          path: filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          isCompressed: file.endsWith(".tar.gz")
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
    path.join(EXPORT_OUTPUT_DIR, exportId),
    path.join(EXPORT_OUTPUT_DIR, `${exportId}.tar.gz`)
  ];

  for (const filePath of possiblePaths) {
    try {
      const stats = await fsp.stat(filePath);
      
      let manifest = null;
      if (stats.isDirectory()) {
        const manifestPath = path.join(filePath, "manifest.json");
        manifest = await readJson(manifestPath, null);
      } else if (filePath.endsWith(".tar.gz")) {
        try {
          const compressed = await fsp.readFile(filePath);
          const decompressed = await gunzip(compressed);
          const archive = JSON.parse(decompressed.toString("utf-8"));
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
        isCompressed: filePath.endsWith(".tar.gz"),
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

async function extractImportPackage(importSource) {
  await ensureExportImportDirs();

  const importId = `import_${generateTimestamp()}_${createId("imp")}`;
  const extractDir = path.join(IMPORT_TEMP_DIR, importId);
  await ensureDir(extractDir);

  let sourcePath = importSource;
  if (!path.isAbsolute(importSource)) {
    sourcePath = path.join(IMPORT_INPUT_DIR, importSource);
  }

  const stats = await fsp.stat(sourcePath);
  let manifest = null;

  if (stats.isDirectory()) {
    await copyDirectory(sourcePath, extractDir);
    const manifestPath = path.join(extractDir, "manifest.json");
    manifest = await readJson(manifestPath, null);
  } else if (sourcePath.endsWith(".tar.gz")) {
    const compressed = await fsp.readFile(sourcePath);
    const decompressed = await gunzip(compressed);
    const archive = JSON.parse(decompressed.toString("utf-8"));
    
    manifest = archive.manifest;
    
    for (const [relativePath, content] of Object.entries(archive.files)) {
      const targetPath = path.join(extractDir, relativePath);
      await ensureDir(path.dirname(targetPath));
      await fsp.writeFile(targetPath, content, "utf-8");
    }
  } else {
    throw new Error(`Unsupported import format: ${sourcePath}`);
  }

  if (!manifest) {
    const manifestPath = path.join(extractDir, "manifest.json");
    manifest = await readJson(manifestPath, null);
  }

  return {
    success: true,
    importId,
    extractDir,
    manifest,
    sourcePath
  };
}

async function validateImportPackage(extractDir, manifest, options = {}) {
  const {
    validateSessions = true,
    validateLeaderboard = true,
    validateEventLog = true
  } = options;

  const issues = [];
  const warnings = [];

  if (!manifest) {
    issues.push({ type: "missing_manifest", message: "Import package is missing manifest.json" });
    return { valid: false, issues, warnings };
  }

  if (manifest.version !== EXPORT_FORMAT_VERSION) {
    warnings.push({
      type: "version_mismatch",
      message: `Import package version ${manifest.version} may not be compatible with current version ${EXPORT_FORMAT_VERSION}`
    });
  }

  if (validateSessions && manifest.includes?.sessions && manifest.sessionCount > 0) {
    const sessionsDir = path.join(extractDir, "sessions");
    try {
      const sessionFiles = await listJsonFiles(sessionsDir);
      if (sessionFiles.length !== manifest.sessionCount) {
        warnings.push({
          type: "session_count_mismatch",
          message: `Manifest reports ${manifest.sessionCount} sessions but found ${sessionFiles.length} files`
        });
      }

      for (const sessionPath of sessionFiles) {
        try {
          const session = await readJson(sessionPath, null);
          if (!session || !session.id) {
            issues.push({
              type: "invalid_session",
              message: `Invalid session file: ${path.basename(sessionPath)}`
            });
          }
        } catch {
          issues.push({
            type: "corrupted_session",
            message: `Corrupted session file: ${path.basename(sessionPath)}`
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        issues.push({
          type: "sessions_read_error",
          message: `Failed to read sessions: ${error.message}`
        });
      }
    }
  }

  if (validateLeaderboard && manifest.includes?.leaderboard) {
    const leaderboardPath = path.join(extractDir, "leaderboard.json");
    try {
      const leaderboard = await readJson(leaderboardPath, null);
      if (leaderboard !== null && !Array.isArray(leaderboard)) {
        issues.push({
          type: "invalid_leaderboard",
          message: "Leaderboard is not an array"
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        issues.push({
          type: "leaderboard_read_error",
          message: `Failed to read leaderboard: ${error.message}`
        });
      }
    }
  }

  if (validateEventLog && manifest.includes?.eventLog) {
    const eventsPath = path.join(extractDir, "events.json");
    try {
      const events = await readJson(eventsPath, null);
      if (events !== null && !Array.isArray(events)) {
        issues.push({
          type: "invalid_events",
          message: "Event log is not an array"
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        issues.push({
          type: "events_read_error",
          message: `Failed to read events: ${error.message}`
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    manifest
  };
}

async function executeImport(extractDir, manifest, options = {}) {
  const {
    importSessions = true,
    importLeaderboard = true,
    importEventLog = true,
    mergeStrategy = "skip_existing",
    dryRun = true,
    progress = null
  } = options;

  const result = {
    success: true,
    dryRun,
    sessions: {
      imported: 0,
      skipped: 0,
      failed: 0,
      total: 0
    },
    leaderboard: {
      imported: 0,
      skipped: 0,
      failed: 0,
      total: 0
    },
    events: {
      imported: 0,
      skipped: 0,
      failed: 0,
      total: 0
    },
    warnings: []
  };

  if (importSessions && manifest.includes?.sessions) {
    const sessionsDir = path.join(extractDir, "sessions");
    
    try {
      const sessionFiles = await listJsonFiles(sessionsDir);
      result.sessions.total = sessionFiles.length;

      for (let i = 0; i < sessionFiles.length; i++) {
        const sessionPath = sessionFiles[i];

        try {
          const session = await readJson(sessionPath, null);
          if (!session || !session.id) {
            result.sessions.failed++;
            continue;
          }

          const targetPath = path.join(SESSION_DIR, `${session.id}.json`);
          const exists = await fsp.access(targetPath).then(() => true).catch(() => false);

          if (exists && mergeStrategy === "skip_existing") {
            result.sessions.skipped++;
            result.warnings.push({
              type: "session_skipped",
              sessionId: session.id,
              reason: "already_exists"
            });
          } else if (!dryRun) {
            await ensureDir(SESSION_DIR);
            await writeJsonAtomic(targetPath, session);
            result.sessions.imported++;
          } else {
            result.sessions.imported++;
          }

        } catch (error) {
          result.sessions.failed++;
          result.warnings.push({
            type: "session_import_failed",
            file: path.basename(sessionPath),
            error: error.message
          });
        }

        if (progress && typeof progress === "function") {
          progress({
            phase: "importing_sessions",
            percent: Math.floor((i + 1) / sessionFiles.length * 30) + 10,
            message: `Importing session ${i + 1} of ${sessionFiles.length}...`
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        result.sessions.failed = manifest.sessionCount || 0;
        result.warnings.push({
          type: "sessions_import_error",
          error: error.message
        });
      }
    }
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

        if (progress && typeof progress === "function") {
          progress({
            phase: "importing_leaderboard",
            percent: 50,
            message: "Importing leaderboard entries..."
          });
        }

        if (!dryRun) {
          const currentLeaderboard = await readJson(LEADERBOARD_FILE, []);
          const existingSessionIds = new Set(currentLeaderboard.map(e => e.sessionId));

          for (const entry of importLeaderboardData) {
            if (existingSessionIds.has(entry.sessionId) && mergeStrategy === "skip_existing") {
              result.leaderboard.skipped++;
            } else {
              if (!existingSessionIds.has(entry.sessionId)) {
                currentLeaderboard.push(entry);
              }
              result.leaderboard.imported++;
            }
          }

          await ensureDir(path.dirname(LEADERBOARD_FILE));
          await writeJsonAtomic(LEADERBOARD_FILE, currentLeaderboard);
        } else {
          result.leaderboard.imported = importLeaderboardData.length;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        result.leaderboard.failed = 1;
        result.warnings.push({
          type: "leaderboard_import_error",
          error: error.message
        });
      }
    }
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

        if (progress && typeof progress === "function") {
          progress({
            phase: "importing_events",
            percent: 75,
            message: "Importing event log..."
          });
        }

        if (!dryRun) {
          const { appendLine } = require("../utils/file-store");
          
          for (const event of importEvents) {
            try {
              await appendLine(EVENTS_LOG_FILE, JSON.stringify(event));
              result.events.imported++;
            } catch {
              result.events.failed++;
            }
          }
        } else {
          result.events.imported = importEvents.length;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        result.events.failed = 1;
        result.warnings.push({
          type: "events_import_error",
          error: error.message
        });
      }
    }
  }

  if (progress && typeof progress === "function") {
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

        imports.push({
          id: file.replace(/\.tar\.gz$/, ""),
          name: file,
          path: filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          isCompressed: file.endsWith(".tar.gz"),
          isDirectory: stats.isDirectory()
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
        metadata: operation.metadata || {}
      };

      progress({
        phase: "preparing",
        percent: 5,
        message: "Preparing export package..."
      });

      const result = await createExportPackage(options);

      progress({
        phase: "completed",
        percent: 100,
        message: "Export completed successfully"
      });

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

      progress({
        phase: "extracting",
        percent: 5,
        message: "Extracting import package..."
      });

      const extractResult = await extractImportPackage(source);

      progress({
        phase: "validating",
        percent: 20,
        message: "Validating import package..."
      });

      const validation = await validateImportPackage(
        extractResult.extractDir,
        extractResult.manifest,
        operation.metadata?.validateOptions || {}
      );

      if (!validation.valid && !operation.metadata?.ignoreValidationErrors) {
        throw new Error(`Import validation failed: ${validation.issues.map(i => i.message).join(", ")}`);
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
          mergeStrategy: operation.metadata?.mergeStrategy || "skip_existing",
          dryRun: operation.dryRun,
          progress
        }
      );

      result.validation = validation;
      result.importId = extractResult.importId;
      result.manifest = extractResult.manifest;

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
  restoreFromImportBackup: importOperationManager.restoreFromBackup
};
