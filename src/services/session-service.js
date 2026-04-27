const {
  MAX_EVENTS_PER_SESSION,
  MAX_EVENT_FUTURE_SKEW_MS,
  MAX_EVENT_PAST_SKEW_MS,
  SESSION_TTL_MS
} = require("../config");
const { EVENT_TYPES, SESSION_STATES } = require("../game-rules");
const { appendEventLog } = require("../repositories/event-log-repo");
const { addLeaderboardEntry } = require("../repositories/leaderboard-repo");
const { getSessionById, listSessions, saveSession } = require("../repositories/session-repo");
const { calculateSessionResult } = require("./scoring-service");
const { createId } = require("../utils/id");
const { isoNow, nowMs } = require("../utils/clock");
const { HttpError } = require("../utils/http-error");

function createSessionService() {
  return {
    async createSession({ playerName }) {
      const session = {
        id: createId("sess"),
        playerName: normalizePlayerName(playerName),
        state: SESSION_STATES.CREATED,
        createdAt: isoNow(),
        startedAt: null,
        finishedAt: null,
        closedAt: null,
        expiredAt: null,
        submittedToLeaderboard: false,
        events: [],
        result: null
      };

      await saveSession(session);
      return session;
    },

    async getSession(sessionId) {
      const session = await requireSession(sessionId);
      return session;
    },

    async startSession(sessionId) {
      const session = await requireSession(sessionId);
      await expireIfNeeded(session);
      ensureState(session, [SESSION_STATES.CREATED], "Session cannot be started");

      session.state = SESSION_STATES.PLAYING;
      session.startedAt = isoNow();

      await saveSession(session);
      return session;
    },

    async addEvent(sessionId, input) {
      const session = await requireSession(sessionId);
      await expireIfNeeded(session);
      ensureState(session, [SESSION_STATES.PLAYING], "Session is not accepting events");

      if (!EVENT_TYPES.includes(input.type)) {
        throw new HttpError(422, "Unsupported event type");
      }

      if (session.events.length >= MAX_EVENTS_PER_SESSION) {
        throw new HttpError(422, "Session event limit exceeded");
      }

      const event = buildEvent(session, input);
      session.events.push(event);

      await saveSession(session);
      await appendEventLog({
        sessionId: session.id,
        playerName: session.playerName,
        ...event
      });

      return event;
    },

    async finishSession(sessionId) {
      const session = await requireSession(sessionId);
      await expireIfNeeded(session);

      if (session.submittedToLeaderboard) {
        throw new HttpError(409, "Session already submitted to leaderboard", {
          currentState: session.state,
          submittedToLeaderboard: true
        });
      }

      ensureState(session, [SESSION_STATES.PLAYING], "Session cannot be finished");

      session.state = SESSION_STATES.FINISHED;
      session.finishedAt = isoNow();
      session.result = calculateSessionResult(session.events);

      const entry = {
        id: createId("rank"),
        sessionId: session.id,
        playerName: session.playerName,
        score: session.result.score,
        createdAt: session.finishedAt,
        summary: session.result.summary
      };

      await addLeaderboardEntry(entry);
      session.submittedToLeaderboard = true;

      await saveSession(session);
      return session;
    },

    async closeSession(sessionId) {
      const session = await requireSession(sessionId);
      await expireIfNeeded(session);
      ensureState(
        session,
        [SESSION_STATES.CREATED, SESSION_STATES.PLAYING],
        "Session cannot be closed"
      );

      session.state = SESSION_STATES.CLOSED;
      session.closedAt = isoNow();

      await saveSession(session);
      return session;
    },

    async cleanupExpiredSessions() {
      const sessions = await listSessions();
      let expiredCount = 0;

      for (const session of sessions) {
        if (isExpiredSession(session)) {
          session.state = SESSION_STATES.EXPIRED;
          session.expiredAt = isoNow();
          await saveSession(session);
          expiredCount += 1;
        }
      }

      return expiredCount;
    }
  };
}

function normalizePlayerName(value) {
  if (typeof value !== "string") {
    return "Guest Cat";
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return (trimmed || "Guest Cat").slice(0, 20);
}

async function requireSession(sessionId) {
  if (!sessionId) {
    throw new HttpError(400, "Session id is required");
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new HttpError(404, "Session not found");
  }

  return session;
}

function ensureState(session, allowedStates, message) {
  if (!allowedStates.includes(session.state)) {
    throw new HttpError(409, message, {
      currentState: session.state,
      allowedStates
    });
  }
}

async function expireIfNeeded(session) {
  if (!isExpiredSession(session)) {
    return;
  }

  session.state = SESSION_STATES.EXPIRED;
  session.expiredAt = isoNow();
  await saveSession(session);
  throw new HttpError(410, "Session expired");
}

function isExpiredSession(session) {
  if (![SESSION_STATES.CREATED, SESSION_STATES.PLAYING].includes(session.state)) {
    return false;
  }

  const baseTime = Date.parse(session.startedAt || session.createdAt);
  return Number.isFinite(baseTime) && nowMs() - baseTime > SESSION_TTL_MS;
}

function buildEvent(session, input) {
  const receivedAtMs = nowMs();
  const startedAtMs = Date.parse(session.startedAt || session.createdAt);
  const occurredAt = input.occurredAt || receivedAtMs;

  if (occurredAt > receivedAtMs + MAX_EVENT_FUTURE_SKEW_MS) {
    throw new HttpError(422, "Event timestamp is too far in the future");
  }

  if (occurredAt < startedAtMs - MAX_EVENT_PAST_SKEW_MS) {
    throw new HttpError(422, "Event timestamp is before session start");
  }

  return {
    id: createId("evt"),
    type: input.type,
    occurredAt,
    receivedAt: new Date(receivedAtMs).toISOString(),
    payload: input.payload || {}
  };
}

module.exports = {
  createSessionService
};
