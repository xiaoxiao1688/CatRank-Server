const { EVENT_SCORES } = require("../game-rules");

function calculateSessionResult(events) {
  const summary = {
    fishCaught: 0,
    goldenFishCaught: 0,
    bombHit: 0,
    enemyDefeated: 0,
    powerUpsUsed: 0,
    skillsUsed: 0,
    maxCombo: 0,
    totalEvents: events.length
  };

  let baseScore = 0;

  for (const event of events) {
    switch (event.type) {
      case "fish_caught":
        summary.fishCaught += 1;
        break;
      case "golden_fish_caught":
        summary.goldenFishCaught += 1;
        break;
      case "bomb_hit":
        summary.bombHit += 1;
        break;
      case "enemy_defeated":
        summary.enemyDefeated += 1;
        break;
      case "power_up_used":
        summary.powerUpsUsed += 1;
        break;
      case "skill_used":
        summary.skillsUsed += 1;
        break;
      default:
        break;
    }

    const combo = Number(event.payload && event.payload.combo);
    if (Number.isFinite(combo) && combo > summary.maxCombo) {
      summary.maxCombo = Math.floor(combo);
    }

    baseScore += EVENT_SCORES[event.type] || 0;
  }

  const comboBonus = Math.max(0, Math.floor(summary.maxCombo / 5) * 5);
  const finalScore = Math.max(0, baseScore + comboBonus);

  return {
    score: finalScore,
    summary,
    breakdown: {
      baseScore,
      comboBonus
    }
  };
}

module.exports = {
  calculateSessionResult
};
