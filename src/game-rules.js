const EVENT_TYPES = [
  "fish_caught",
  "golden_fish_caught",
  "bomb_hit",
  "enemy_defeated",
  "power_up_used",
  "skill_used"
];

const SESSION_STATES = {
  CREATED: "created",
  PLAYING: "playing",
  FINISHED: "finished",
  CLOSED: "closed",
  EXPIRED: "expired"
};

const EVENT_SCORES = {
  fish_caught: 10,
  golden_fish_caught: 25,
  bomb_hit: -10,
  enemy_defeated: 15,
  power_up_used: 0,
  skill_used: 0
};

module.exports = {
  EVENT_TYPES,
  EVENT_SCORES,
  SESSION_STATES
};
