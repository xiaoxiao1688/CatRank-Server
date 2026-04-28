const { SESSION_STATES, EVENT_TYPES } = require("../game-rules");
const { calculateSessionResult } = require("./scoring-service");

function buildReplaySession(parsedSession, leaderboardEntry = null) {
  const sessionId = parsedSession.sessionId;
  
  const session = {
    id: sessionId,
    playerName: parsedSession.playerName || "Guest Cat",
    state: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    closedAt: null,
    expiredAt: null,
    submittedToLeaderboard: false,
    events: [],
    result: null
  };

  for (const eventInfo of parsedSession.events) {
    const record = eventInfo.record;
    session.events.push({
      id: record.id,
      type: record.type,
      occurredAt: record.occurredAt,
      receivedAt: record.receivedAt,
      payload: record.payload || {}
    });
  }

  session.events.sort((a, b) => a.occurredAt - b.occurredAt);

  if (session.events.length > 0) {
    const firstEventTime = session.events[0].occurredAt;
    session.createdAt = new Date(firstEventTime - 1000).toISOString();
    session.startedAt = new Date(firstEventTime - 500).toISOString();
  }

  if (leaderboardEntry) {
    session.state = SESSION_STATES.FINISHED;
    session.finishedAt = leaderboardEntry.createdAt;
    session.submittedToLeaderboard = true;
    session.result = calculateSessionResult(session.events);
  } else {
    session.state = SESSION_STATES.PLAYING;
  }

  return session;
}

function detectStateConflict(replayedSession, existingSession) {
  const conflicts = [];
  const warnings = [];

  const existingEventIds = new Set(existingSession.events.map(e => e.id));
  const replayedEventIds = new Set(replayedSession.events.map(e => e.id));

  const missingFromExisting = [];
  const extraInExisting = [];

  for (const id of replayedEventIds) {
    if (!existingEventIds.has(id)) {
      missingFromExisting.push(id);
    }
  }

  for (const id of existingEventIds) {
    if (!replayedEventIds.has(id)) {
      extraInExisting.push(id);
    }
  }

  if (existingSession.state === SESSION_STATES.CLOSED && replayedSession.events.length > 0) {
    conflicts.push({
      type: "closed_with_events",
      message: "Existing session is CLOSED but event log contains events for this session",
      existingState: SESSION_STATES.CLOSED,
      logHasEvents: true
    });
  }

  if (existingSession.state === SESSION_STATES.EXPIRED && replayedSession.events.length > 0) {
    conflicts.push({
      type: "expired_with_events",
      message: "Existing session is EXPIRED but event log contains events for this session",
      existingState: SESSION_STATES.EXPIRED,
      logHasEvents: true
    });
  }

  if (extraInExisting.length > 0) {
    warnings.push({
      type: "extra_events",
      count: extraInExisting.length,
      eventIds: extraInExisting.slice(0, 10),
      message: `Existing session has ${extraInExisting.length} events not in log (may be from incomplete log)`
    });
  }

  if (existingSession.submittedToLeaderboard !== replayedSession.submittedToLeaderboard) {
    if (existingSession.submittedToLeaderboard && !replayedSession.submittedToLeaderboard) {
      warnings.push({
        type: "submission_mismatch",
        message: "Existing session submitted to leaderboard but log doesn't indicate finish (leaderboard used for inference)"
      });
    } else {
      conflicts.push({
        type: "submission_mismatch",
        message: "Log indicates session should be submitted but existing is not",
        existing: existingSession.submittedToLeaderboard,
        replayed: replayedSession.submittedToLeaderboard
      });
    }
  }

  if (replayedSession.result && existingSession.result) {
    if (replayedSession.result.score !== existingSession.result.score) {
      conflicts.push({
        type: "score_mismatch",
        existing: existingSession.result.score,
        replayed: replayedSession.result.score,
        message: `Score mismatch: existing ${existingSession.result.score}, replayed ${replayedSession.result.score}`
      });
    }
  }

  return {
    conflicts,
    warnings,
    hasConflicts: conflicts.length > 0,
    hasWarnings: warnings.length > 0
  };
}

function checkNeedsUpdate(existingSession, replayedSession) {
  if (existingSession.events.length !== replayedSession.events.length) {
    return true;
  }

  const existingEventIds = new Set(existingSession.events.map(e => e.id));
  for (const event of replayedSession.events) {
    if (!existingEventIds.has(event.id)) {
      return true;
    }
  }

  if (existingSession.submittedToLeaderboard !== replayedSession.submittedToLeaderboard) {
    return true;
  }

  if (existingSession.state !== replayedSession.state) {
    return true;
  }

  return false;
}

function replaySession(parsedSession, existingSession = null, leaderboardEntry = null) {
  const replayedSession = buildReplaySession(parsedSession, leaderboardEntry);
  
  const result = {
    sessionId: parsedSession.sessionId,
    playerName: replayedSession.playerName,
    session: replayedSession,
    existingSession: existingSession ? { ...existingSession } : null,
    leaderboardEntry: leaderboardEntry ? { ...leaderboardEntry } : null,
    hasDuplicates: parsedSession.hasDuplicates,
    stateConflict: null,
    stateWarnings: [],
    canRecover: true,
    recoveryAction: null,
    issues: [],
    warnings: []
  };

  if (parsedSession.hasDuplicates) {
    result.warnings.push({
      type: "duplicate_events",
      message: "Session has duplicate events in log (duplicates were skipped during parsing)"
    });
  }

  if (existingSession) {
    const conflictResult = detectStateConflict(replayedSession, existingSession);
    
    if (conflictResult.hasConflicts) {
      result.stateConflict = conflictResult.conflicts;
      result.issues.push(...conflictResult.conflicts.map(c => ({
        type: c.type,
        message: c.message
      })));
      result.canRecover = false;
    }

    if (conflictResult.hasWarnings) {
      result.stateWarnings = conflictResult.warnings;
      result.warnings.push(...conflictResult.warnings.map(w => ({
        type: w.type,
        message: w.message
      })));
    }

    if (result.canRecover) {
      const needsUpdate = checkNeedsUpdate(existingSession, replayedSession);
      if (needsUpdate) {
        result.recoveryAction = "needs_update";
      } else {
        result.recoveryAction = "up_to_date";
      }
    }
  } else {
    result.recoveryAction = "needs_creation";
  }

  return result;
}

module.exports = {
  replaySession,
  buildReplaySession,
  detectStateConflict,
  checkNeedsUpdate
};
