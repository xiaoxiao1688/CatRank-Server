const express = require("express");
const { z } = require("zod");

const { EVENT_TYPES } = require("../game-rules");

const createSessionSchema = z.object({
  playerName: z.string().trim().max(20).optional()
});

const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  occurredAt: z.number().int().positive().optional(),
  payload: z.record(z.any()).optional()
});

function createSessionsRouter({ sessionService }) {
  const router = express.Router();

  router.post("/", asyncHandler(async (req, res) => {
    const body = createSessionSchema.parse(req.body || {});
    const session = await sessionService.createSession(body);
    res.status(201).json({
      ok: true,
      sessionId: session.id,
      state: session.state,
      createdAt: session.createdAt
    });
  }));

  router.post("/:sessionId/start", asyncHandler(async (req, res) => {
    const session = await sessionService.startSession(req.params.sessionId);
    res.json({
      ok: true,
      sessionId: session.id,
      state: session.state,
      startedAt: session.startedAt
    });
  }));

  router.post("/:sessionId/events", asyncHandler(async (req, res) => {
    const body = eventSchema.parse(req.body || {});
    const event = await sessionService.addEvent(req.params.sessionId, body);
    res.status(201).json({
      ok: true,
      accepted: true,
      eventId: event.id
    });
  }));

  router.post("/:sessionId/finish", asyncHandler(async (req, res) => {
    const session = await sessionService.finishSession(req.params.sessionId);
    res.json({
      ok: true,
      sessionId: session.id,
      state: session.state,
      result: session.result
    });
  }));

  router.post("/:sessionId/close", asyncHandler(async (req, res) => {
    const session = await sessionService.closeSession(req.params.sessionId);
    res.json({
      ok: true,
      sessionId: session.id,
      state: session.state,
      closedAt: session.closedAt
    });
  }));

  router.get("/:sessionId", asyncHandler(async (req, res) => {
    const session = await sessionService.getSession(req.params.sessionId);
    res.json({
      ok: true,
      session
    });
  }));

  router.post("/cleanup-expired", asyncHandler(async (req, res) => {
    const expiredCount = await sessionService.cleanupExpiredSessions();
    res.json({
      ok: true,
      expiredCount
    });
  }));

  return router;
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  createSessionsRouter
};
