const { parseEventLog } = require("./event-log-parser");
const { replaySession } = require("./session-replayer");
const { getSessionById, saveSession, withSessionLock } = require("../repositories/session-repo");
const { listLeaderboardEntries, addLeaderboardEntry } = require("../repositories/leaderboard-repo");
const { SESSION_STATES } = require("../game-rules");
const { createId } = require("../utils/id");

async function createRecoveryService(options = {}) {
  const { dryRun = true, logFilePath = null } = options;

  async function runRecovery() {
    const report = {
      dryRun,
      timestamp: new Date().toISOString(),
      summary: {
        totalSessions: 0,
        recovered: 0,
        skipped: 0,
        failed: 0,
        corruptedLines: 0,
        duplicateEvents: 0,
        stateConflicts: 0
      },
      details: {
        sessions: [],
        corruptedLines: [],
        duplicateEvents: [],
        issues: []
      }
    };

    try {
      const parseResult = logFilePath 
        ? await parseEventLog(logFilePath)
        : await parseEventLog();

      if (!parseResult.ok) {
        report.error = {
          message: "Failed to parse event log",
          error: parseResult.error ? parseResult.error.message : "Unknown error"
        };
        return report;
      }

      report.summary.corruptedLines = parseResult.corruptedLines.length;
      report.summary.duplicateEvents = parseResult.duplicateEvents.length;
      report.details.corruptedLines = parseResult.corruptedLines;
      report.details.duplicateEvents = parseResult.duplicateEvents;

      const existingLeaderboard = await listLeaderboardEntries();
      const leaderboardMap = new Map();
      for (const entry of existingLeaderboard) {
        leaderboardMap.set(entry.sessionId, entry);
      }

      const sessionIds = Object.keys(parseResult.sessions);
      report.summary.totalSessions = sessionIds.length;

      for (const sessionId of sessionIds) {
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
        }

        if (!replayResult.canRecover) {
          report.summary.failed++;
          sessionReport.recoveryAction = "failed";
          report.details.sessions.push(sessionReport);
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
      }

      report.success = true;

    } catch (error) {
      report.error = {
        message: "Recovery process failed",
        error: error.message,
        stack: error.stack
      };
      report.success = false;
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
    runRecovery
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
