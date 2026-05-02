const express = require("express");
const { z } = require("zod");

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

function createLeaderboardRouter({ leaderboardService }) {
  const router = express.Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const result = await leaderboardService.getLeaderboardPage(query);
    res.json({
      ok: true,
      ...result
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
  createLeaderboardRouter
};
