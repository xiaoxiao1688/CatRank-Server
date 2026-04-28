const { listLeaderboardEntries } = require("../repositories/leaderboard-repo");

function createLeaderboardService() {
  return {
    async getLeaderboardPage({ page, pageSize }) {
      const entries = await listLeaderboardEntries();
      const sorted = [...entries].sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      });

      const total = sorted.length;
      const startIndex = (page - 1) * pageSize;
      const items = sorted.slice(startIndex, startIndex + pageSize).map((entry, index) => ({
        rank: startIndex + index + 1,
        sessionId: entry.sessionId,
        playerName: entry.playerName,
        score: entry.score,
        createdAt: entry.createdAt,
        summary: entry.summary
      }));

      return {
        page,
        pageSize,
        total,
        items
      };
    }
  };
}

module.exports = {
  createLeaderboardService
};
