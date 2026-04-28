const { parseEventLog } = require("./event-log-parser");
const { replaySession } = require("./session-replayer");
const { getSessionById, saveSession, withSessionLock } = require("../repositories/session-repo");
const { listLeaderboardEntries, addLeaderboardEntry } = require("../repositories/leaderboard-repo");
const { SESSION_STATES } = require("../game-rules");
const { createId } = require("../utils/id");
const {
  isRecoveryInterrupted,
  updateProgress,
  startRecoveryTracking,
  completeRecoveryTracking,
  getCurrentProgress,
  quarantineCorruptedLogLines,
  quarantineCorruptedSession,
  createTransaction,
  rollbackTransaction,
  clearActiveTransaction,
  validateRecoveryResult
} = require("./recovery-manager");

async function createRecoveryService(options = {}) {
  const { 
    dryRun = true, 
    logFilePath = null,
    createBackup = true,
    quarantineCorrupted = true,
    enableTransaction = true,
    onProgress = null
  } = options;

  let transaction = null;

  function emitProgress(progress) {
    updateProgress(progress);
    if (onProgress && typeof onProgress === "function") {
      onProgress(progress);
    }
  }

  function checkInterruption() {
    if (isRecoveryInterrupted()) {
      throw new Error("Recovery was interrupted");
    }
  }

  async function performRollback(trackingState, transaction) {
    if (enableTransaction && !dryRun) {
      const currentProgress = getCurrentProgress();
      emitProgress({
        phase: "rolling_back",
        percent: currentProgress?.percent || 0,
        message: "Rolling back changes..."
      });
      
      const rollbackResult = await rollbackTransaction(
        transaction?.transactionId,
        trackingState.backupResult
      );
      
      return rollbackResult;
    }
    return { skipped: true, reason: "transaction_disabled_or_dry_run" };
  }

  async function runRecovery() {
    if (enableTransaction && !dryRun) {
      transaction = await createTransaction();
    }

    const trackingState = await startRecoveryTracking({ dryRun, createBackup });
    
    const report = {
      dryRun,
      createBackup,
      enableTransaction,
      transactionId: transaction?.transactionId || null,
      backupResult: trackingState.backupResult,
      timestamp: new Date().toISOString(),
      summary: {
        totalSessions: 0,
        recovered: 0,
        skipped: 0,
        failed: 0,
        corruptedLines: 0,
        duplicateEvents: 0,
        stateConflicts: 0,
        quarantinedItems: 0
      },
      details: {
        sessions: [],
        corruptedLines: [],
        duplicateEvents: [],
        quarantined: [],
        issues: []
      }
    };

    let rolledBack = false;
    let rollbackResult = null;

    try {
      emitProgress({
        phase: "parsing_log",
        percent: 10,
        message: "Parsing event log..."
      });
      checkInterruption();

      const parseResult = logFilePath 
        ? await parseEventLog(logFilePath)
        : await parseEventLog();

      if (!parseResult.ok) {
        report.error = {
          message: "Failed to parse event log",
          error: parseResult.error ? parseResult.error.message : "Unknown error"
        };
        
        if (enableTransaction && !dryRun && createBackup && trackingState.backupResult?.success) {
          rollbackResult = await performRollback(trackingState, transaction);
          rolledBack = rollbackResult.rolledBack;
          report.rollbackResult = rollbackResult;
        }
        
        await completeRecoveryTracking(report, false);
        return report;
      }

      report.summary.corruptedLines = parseResult.corruptedLines.length;
      report.summary.duplicateEvents = parseResult.duplicateEvents.length;
      report.details.corruptedLines = parseResult.corruptedLines;
      report.details.duplicateEvents = parseResult.duplicateEvents;

      if (parseResult.corruptedLines.length > 0 && quarantineCorrupted && !dryRun) {
        emitProgress({
          phase: "quarantining",
          percent: 15,
          message: "Quarantining corrupted log lines..."
        });
        
        const quarantineResult = await quarantineCorruptedLogLines(parseResult.corruptedLines, logFilePath);
        if (quarantineResult.success) {
          report.summary.quarantinedItems += quarantineResult.quarantined;
          report.details.quarantined.push({
            type: "corrupted_log_lines",
            quarantineId: quarantineResult.quarantineId,
            count: quarantineResult.quarantined
          });
        }
      }

      checkInterruption();

      emitProgress({
        phase: "loading_existing_data",
        percent: 20,
        message: "Loading existing session and leaderboard data..."
      });

      const existingLeaderboard = await listLeaderboardEntries();
      const leaderboardMap = new Map();
      for (const entry of existingLeaderboard) {
        leaderboardMap.set(entry.sessionId, entry);
      }

      const sessionIds = Object.keys(parseResult.sessions);
      report.summary.totalSessions = sessionIds.length;

      let processedCount = 0;

      for (const sessionId of sessionIds) {
        checkInterruption();
        
        const progressPercent = 20 + Math.floor((processedCount / sessionIds.length) * 70);
        emitProgress({
          phase: "processing_sessions",
          percent: progressPercent,
          message: `Processing session ${processedCount + 1} of ${sessionIds.length}...`,
          currentSession: sessionId,
          processedCount,
          totalCount: sessionIds.length
        });
        
        checkInterruption();

        const parsedSession = parseResult.sessions[sessionId];
        const existingSession = await getSessionById(sessionId);
        const leaderboardEntry = leaderboardMap.get(sessionId);

        const replayResult = replaySession(parsedSession, existingSession, leaderboardEntry);
        
        const sessionReport = {
          sessionId,
          playerName: replayResult.playerName,
          existingSession: existingSession ? true : false,
          inLeaderboard: leaderboardEntry ? true : false,
          canRecover: replayResult.canRecover,
          hasDuplicates: replayResult.hasDuplicates,
          hasStateConflicts: replayResult.stateConflict !== null,
          state: replayResult.session.state,
          eventCount: replayResult.session.events.length,
          submittedToLeaderboard: replayResult.session.submittedToLeaderboard,
          recoveryAction: null,
          issues: [...replayResult.issues],
          warnings: [...replayResult.warnings]
        };

        if (replayResult.stateConflict) {
          report.summary.stateConflicts++;
          
          if (quarantineCorrupted && !dryRun) {
            const quarantineResult = await quarantineCorruptedSession(
              sessionId, 
              "State conflict detected during recovery",
              existingSession || replayResult.session
            );
            if (quarantineResult.success) {
              report.summary.quarantinedItems++;
              report.details.quarantined.push({
                type: "conflicting_session",
                quarantineId: quarantineResult.quarantineId,
                sessionId
              });
            }
          }
        }

        if (!replayResult.canRecover) {
          report.summary.failed++;
          sessionReport.recoveryAction = "failed";
          report.details.sessions.push(sessionReport);
          processedCount++;
          continue;
        }

        if (existingSession) {
          if (replayResult.recoveryAction === "up_to_date") {
            sessionReport.recoveryAction = "skipped_up_to_date";
            report.summary.skipped++;
          } else if (replayResult.recoveryAction === "needs_update") {
            if (dryRun) {
              sessionReport.recoveryAction = "would_update";
              sessionReport.warnings.push({
                type: "would_update",
                message: "Would update existing session in real recovery mode"
              });
            } else {
              await performSessionRecovery(replayResult.session, leaderboardMap);
              sessionReport.recoveryAction = "updated";
            }
            report.summary.recovered++;
          }
        } else {
          if (dryRun) {
            sessionReport.recoveryAction = "would_create";
          } else {
            await performSessionRecovery(replayResult.session, leaderboardMap);
            sessionReport.recoveryAction = "created";
          }
          report.summary.recovered++;
        }

        report.details.sessions.push(sessionReport);
        processedCount++;
      }

      emitProgress({
        phase: "validating",
        percent: 92,
        message: "Validating recovery result..."
      });

      const validation = await validateRecoveryResult(
        parseResult.totalEvents || 0,
        sessionIds.length,
        { ...report, success: true }
      );

      report.validation = validation;
      
      if (!validation.valid) {
        report.details.issues.push(...validation.issues);
        
        if (enableTransaction && !dryRun && createBackup && trackingState.backupResult?.success) {
          emitProgress({
            phase: "rolling_back",
            percent: 95,
            message: "Validation failed, rolling back..."
          });
          
          rollbackResult = await performRollback(trackingState, transaction);
          rolledBack = rollbackResult.rolledBack;
          report.rollbackResult = rollbackResult;
          report.success = false;
        } else {
          report.success = true;
        }
      } else {
        report.success = true;
      }

      emitProgress({
        phase: "finalizing",
        percent: 98,
        message: "Finalizing recovery report..."
      });
      
      await completeRecoveryTracking(report, report.success);

      emitProgress({
        phase: "completed",
        percent: 100,
        message: rolledBack ? "Recovery rolled back" : "Recovery completed successfully"
      });

    } catch (error) {
      report.error = {
        message: error.message === "Recovery was interrupted" 
          ? "Recovery was interrupted" 
          : "Recovery process failed",
        error: error.message,
        stack: error.stack
      };
      report.success = false;
      
      if (error.message === "Recovery was interrupted") {
        report.wasInterrupted = true;
      }
      
      if (enableTransaction && !dryRun && createBackup && trackingState.backupResult?.success) {
        rollbackResult = await performRollback(trackingState, transaction);
        rolledBack = rollbackResult.rolledBack;
        report.rollbackResult = rollbackResult;
      }
      
      await completeRecoveryTracking(report, false);
    } finally {
      if (transaction) {
        clearActiveTransaction();
      }
    }

    return report;
  }

  async function performSessionRecovery(session, leaderboardMap) {
    if (session.state === SESSION_STATES.FINISHED && session.submittedToLeaderboard) {
      if (!leaderboardMap.has(session.id)) {
        const entry = {
          id: createId("rank"),
          sessionId: session.id,
          playerName: session.playerName,
          score: session.result.score,
          createdAt: session.finishedAt,
          summary: session.result.summary
        };
        await addLeaderboardEntry(entry);
        leaderboardMap.set(session.id, entry);
      }
    }

    await withSessionLock(session.id, async () => {
      await saveSession(session);
    });
  }

  return {
    runRecovery,
    getProgress: getCurrentProgress
  };
}

async function runRecoveryWithOptions(options = {}) {
  const service = await createRecoveryService(options);
  return service.runRecovery();
}

module.exports = {
  createRecoveryService,
  runRecoveryWithOptions
};
