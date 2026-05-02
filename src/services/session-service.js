const {
  MAX_EVENTS_PER_SESSION,
  MAX_EVENT_FUTURE_SKEW_MS,
  MAX_EVENT_PAST_SKEW_MS,
  SESSION_TTL_MS,
  MAX_COMBO_VALUE,
  MAX_EVENTS_PER_SECOND,
  MIN_EVENT_INTERVAL_MS,
  EVENT_FREQUENCY_WINDOW_MS
} = require("../config");
const { EVENT_TYPES, SESSION_STATES } = require("../game-rules");
const { appendEventLog } = require("../repositories/event-log-repo");
const { addLeaderboardEntry } = require("../repositories/leaderboard-repo");
const {
  getSessionById,
  listSessions,
  saveSession,
  withSessionLock
} = require("../repositories/session-repo");
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
      return withSessionLock(sessionId, async () => {
        let session = await getSessionById(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }

        await expireIfNeededWithSave(session);
        ensureState(session, [SESSION_STATES.CREATED], "Session cannot be started");

        session.state = SESSION_STATES.PLAYING;
        session.startedAt = isoNow();

        await saveSession(session);
        return session;
      });
    },

    async addEvent(sessionId, input) {
      return withSessionLock(sessionId, async () => {
        let session = await getSessionById(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }

        await expireIfNeededWithSave(session);
        ensureState(session, [SESSION_STATES.PLAYING], "Session is not accepting events");

        if (!EVENT_TYPES.includes(input.type)) {
          throw new HttpError(422, "Unsupported event type");
        }

        if (session.events.length >= MAX_EVENTS_PER_SESSION) {
          throw new HttpError(422, "Session event limit exceeded");
        }

        validateEventPayload(input);
        validateEventOrder(session, input);
        validateEventFrequency(session, input);

        const event = buildEvent(session, input);

        const eventRecord = {
          sessionId: session.id,
          playerName: session.playerName,
          ...event
        };
        await appendEventLog(eventRecord);

        session.events.push(event);
        await saveSession(session);

        return event;
      });
    },

    async finishSession(sessionId) {
      return withSessionLock(sessionId, async () => {
        let session = await getSessionById(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }

        await expireIfNeededWithSave(session);

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
      });
    },

    async closeSession(sessionId) {
      return withSessionLock(sessionId, async () => {
        let session = await getSessionById(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }

        await expireIfNeededWithSave(session);
        ensureState(
          session,
          [SESSION_STATES.CREATED, SESSION_STATES.PLAYING],
          "Session cannot be closed"
        );

        session.state = SESSION_STATES.CLOSED;
        session.closedAt = isoNow();

        await saveSession(session);
        return session;
      });
    },

    async cleanupExpiredSessions() {
      const sessions = await listSessions();
      let expiredCount = 0;

      for (const session of sessions) {
        if (isExpiredSession(session)) {
          const result = await withSessionLock(session.id, async () => {
            const lockedSession = await getSessionById(session.id);
            if (lockedSession && isExpiredSession(lockedSession)) {
              lockedSession.state = SESSION_STATES.EXPIRED;
              lockedSession.expiredAt = isoNow();
              await saveSession(lockedSession);
              return lockedSession;
            }
            return null;
          });
          if (result) {
            expiredCount += 1;
          }
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

async function expireIfNeededWithSave(session) {
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

function validateEventPayload(input) {
  if (input.payload === undefined || input.payload === null) {
    return;
  }

  if (typeof input.payload !== "object") {
    throw new HttpError(422, "Invalid payload format");
  }

  if (input.payload.combo !== undefined) {
    const combo = Number(input.payload.combo);
    if (!Number.isFinite(combo)) {
      throw new HttpError(422, "Invalid combo value", {
        field: "payload.combo",
        reason: "must be a number"
      });
    }
    if (!Number.isInteger(combo) || combo < 0) {
      throw new HttpError(422, "Invalid combo value", {
        field: "payload.combo",
        reason: "must be a non-negative integer"
      });
    }
    if (combo > MAX_COMBO_VALUE) {
      throw new HttpError(422, "Combo value too large", {
        field: "payload.combo",
        max: MAX_COMBO_VALUE,
        actual: combo
      });
    }
  }
}

function validateEventOrder(session, input) {
  if (session.events.length === 0) {
    return;
  }

  const lastEvent = session.events[session.events.length - 1];
  const newOccurredAt = input.occurredAt || nowMs();

  if (newOccurredAt < lastEvent.occurredAt - MAX_EVENT_PAST_SKEW_MS) {
    throw new HttpError(422, "Event timestamp out of order", {
      lastEventAt: lastEvent.occurredAt,
      newEventAt: newOccurredAt,
      maxAllowedSkewMs: MAX_EVENT_PAST_SKEW_MS
    });
  }
}

function validateEventFrequency(session, input) {
  if (session.events.length === 0) {
    return;
  }

  const currentTime = nowMs();
  const windowStart = currentTime - EVENT_FREQUENCY_WINDOW_MS;

  const eventsInWindow = session.events.filter((event) => {
    const eventTime = event.occurredAt;
    return eventTime >= windowStart && eventTime <= currentTime;
  });

  if (eventsInWindow.length >= MAX_EVENTS_PER_SECOND) {
    throw new HttpError(429, "Too many events", {
      windowMs: EVENT_FREQUENCY_WINDOW_MS,
      maxEvents: MAX_EVENTS_PER_SECOND,
      currentCount: eventsInWindow.length
    });
  }

  const lastEvent = session.events[session.events.length - 1];
  const newOccurredAt = input.occurredAt || currentTime;
  const timeSinceLastEvent = newOccurredAt - lastEvent.occurredAt;

  if (timeSinceLastEvent < MIN_EVENT_INTERVAL_MS && timeSinceLastEvent >= 0) {
    throw new HttpError(429, "Events too frequent", {
      minIntervalMs: MIN_EVENT_INTERVAL_MS,
      timeSinceLastEventMs: timeSinceLastEvent
    });
  }
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
