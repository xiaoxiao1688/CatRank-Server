const express = require("express");
const { z } = require("zod");

const { createSessionsRouter } = require("./routes/sessions");
const { createLeaderboardRouter } = require("./routes/leaderboard");
const { createRecoveryRouter } = require("./routes/recovery");
const { createExportImportRouter } = require("./routes/export-import");
const { createEvidenceRouter } = require("./routes/evidence");
const { HttpError } = require("./utils/http-error");

function isZodError(error) {
  return error instanceof z.ZodError;
}

function formatZodError(error) {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return {
      field: path || "[body]",
      message: issue.message,
      code: issue.code
    };
  });

  return {
    ok: false,
    message: "Validation failed",
    details: {
      issues
    }
  };
}

function createApp({ sessionService, leaderboardService }) {
  const app = express();

  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/sessions", createSessionsRouter({ sessionService }));
  app.use("/api/leaderboard", createLeaderboardRouter({ leaderboardService }));
  app.use("/api/recovery", createRecoveryRouter());
  app.use("/api/export-import", createExportImportRouter());
  app.use("/api/evidence", createEvidenceRouter());

  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      message: "Route not found"
    });
  });

  app.use((error, _req, res, _next) => {
    if (isZodError(error)) {
      return res.status(400).json(formatZodError(error));
    }

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        ok: false,
        message: error.message,
        details: error.details || null
      });
    }

    console.error("[ERROR] Unhandled request failure", error);
    return res.status(500).json({
      ok: false,
      message: "Internal server error"
    });
  });

  return app;
}

module.exports = {
  createApp
};
