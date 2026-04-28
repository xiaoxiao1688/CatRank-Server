const { createApp } = require("./app");
const { HOST, PORT } = require("./config");
const { ensureSessionStorage } = require("./repositories/session-repo");
const { ensureLeaderboardStorage } = require("./repositories/leaderboard-repo");
const { ensureEventLogStorage } = require("./repositories/event-log-repo");
const { ensureRecoveryDirs } = require("./services/recovery-manager");
const { createSessionService } = require("./services/session-service");
const { createLeaderboardService } = require("./services/leaderboard-service");

async function bootstrap() {
  await Promise.all([
    ensureSessionStorage(),
    ensureLeaderboardStorage(),
    ensureEventLogStorage(),
    ensureRecoveryDirs()
  ]);

  const sessionService = createSessionService();
  const leaderboardService = createLeaderboardService();
  const app = createApp({ sessionService, leaderboardService });

  setInterval(() => {
    sessionService.cleanupExpiredSessions().catch((error) => {
      console.error("[WARN] Failed to clean expired sessions", error);
    });
  }, 60 * 1000).unref();

  app.listen(PORT, HOST, () => {
    console.log(`CatRank Server listening at http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("[ERROR] Failed to start server", error);
  process.exitCode = 1;
});
