const { EVENTS_LOG_FILE } = require("../config");
const { readLinesSafe } = require("../utils/file-store");
const { EVENT_TYPES, SESSION_STATES } = require("../game-rules");

function isValidEventRecord(record) {
  if (!record || typeof record !== "object") {
    return false;
  }

  if (typeof record.sessionId !== "string" || !record.sessionId) {
    return false;
  }

  if (typeof record.id !== "string" || !record.id) {
    return false;
  }

  if (typeof record.type !== "string" || !EVENT_TYPES.includes(record.type)) {
    return false;
  }

  if (typeof record.occurredAt !== "number" || !Number.isFinite(record.occurredAt)) {
    return false;
  }

  if (typeof record.receivedAt !== "string" || !record.receivedAt) {
    return false;
  }

  return true;
}

function parseEventLine(rawLine, lineNumber) {
  try {
    const record = JSON.parse(rawLine);

    if (!isValidEventRecord(record)) {
      return {
        valid: false,
        lineNumber,
        raw: rawLine,
        error: "Invalid event record structure",
        errorType: "invalid_structure"
      };
    }

    return {
      valid: true,
      lineNumber,
      record,
      raw: rawLine
    };
  } catch (error) {
    return {
      valid: false,
      lineNumber,
      raw: rawLine,
      error: error.message,
      errorType: "json_parse_error"
    };
  }
}

async function parseEventLog(logFilePath = EVENTS_LOG_FILE) {
  const linesResult = await readLinesSafe(logFilePath);

  if (!linesResult.ok) {
    return {
      ok: false,
      error: linesResult.error,
      errorCode: linesResult.error.code || "UNKNOWN",
      isNotFound: false,
      sessions: {},
      corruptedLines: [],
      totalLines: 0,
      validLines: 0
    };
  }

  if (linesResult.isNotFound) {
    return {
      ok: true,
      isNotFound: true,
      sessions: {},
      corruptedLines: [],
      totalLines: 0,
      validLines: 0
    };
  }

  const sessions = {};
  const corruptedLines = [];
  const eventIds = new Set();
  const duplicateEvents = [];

  for (const lineInfo of linesResult.validLines) {
    const parsed = parseEventLine(lineInfo.raw, lineInfo.lineNumber);
    
    if (!parsed.valid) {
      corruptedLines.push({
        lineNumber: parsed.lineNumber,
        raw: parsed.raw,
        error: parsed.error,
        errorType: parsed.errorType
      });
      continue;
    }

    const record = parsed.record;
    const sessionId = record.sessionId;

    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        sessionId,
        playerName: record.playerName || null,
        events: [],
        hasDuplicates: false,
        inferredState: SESSION_STATES.PLAYING
      };
    }

    if (sessions[sessionId].playerName === null && record.playerName) {
      sessions[sessionId].playerName = record.playerName;
    }

    if (eventIds.has(record.id)) {
      duplicateEvents.push({
        lineNumber: parsed.lineNumber,
        sessionId,
        eventId: record.id
      });
      sessions[sessionId].hasDuplicates = true;
      continue;
    }

    eventIds.add(record.id);
    sessions[sessionId].events.push({
      record,
      lineNumber: parsed.lineNumber
    });
  }

  for (const lineNumber of linesResult.invalidLineNumbers) {
    corruptedLines.push({
      lineNumber,
      raw: null,
      error: "Invalid JSON format",
      errorType: "json_syntax_error"
    });
  }

  for (const sessionId of Object.keys(sessions)) {
    const session = sessions[sessionId];
    session.events.sort((a, b) => a.record.occurredAt - b.record.occurredAt);
    
    if (session.events.length > 0) {
      session.firstEventAt = session.events[0].record.occurredAt;
      session.lastEventAt = session.events[session.events.length - 1].record.occurredAt;
    }
  }

  const validLinesCount = linesResult.validLines.length - corruptedLines.filter(c => c.raw !== null).length;

  return {
    ok: true,
    isNotFound: false,
    sessions,
    corruptedLines,
    duplicateEvents,
    totalLines: linesResult.validLines.length + linesResult.invalidLineNumbers.length,
    validLines: validLinesCount,
    hasCorruption: corruptedLines.length > 0,
    hasDuplicates: duplicateEvents.length > 0,
    hasConflicts: false
  };
}

module.exports = {
  parseEventLog,
  parseEventLine,
  isValidEventRecord
};
