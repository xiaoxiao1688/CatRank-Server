(function() {
  'use strict';

  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");

  const scoreValue = document.getElementById("score-value");
  const livesValue = document.getElementById("lives-value");
  const timeValue = document.getElementById("time-value");
  const levelValue = document.getElementById("level-value");
  const comboValue = document.getElementById("combo-value");
  const coinsValue = document.getElementById("coins-value");

  const startOverlay = document.getElementById("start-overlay");
  const pauseOverlay = document.getElementById("pause-overlay");
  const gameoverOverlay = document.getElementById("gameover-overlay");

  const pauseScore = document.getElementById("pause-score");
  const pauseTime = document.getElementById("pause-time");

  const finalScoreDisplay = document.getElementById("final-score-display");
  const finalMaxCombo = document.getElementById("final-max-combo");
  const finalFishCaught = document.getElementById("final-fish-caught");
  const finalGoldenCaught = document.getElementById("final-golden-caught");
  const finalCoinsEarned = document.getElementById("final-coins-earned");
  const gameoverTag = document.getElementById("gameover-tag");
  const gameoverTitle = document.getElementById("gameover-title");

  const startButton = document.getElementById("start-button");
  const overlayStartButton = document.getElementById("overlay-start-button");
  const refreshButton = document.getElementById("refresh-button");
  const resumeButton = document.getElementById("resume-button");
  const quitButton = document.getElementById("quit-button");
  const playAgainButton = document.getElementById("play-again-button");
  const submitScoreButton = document.getElementById("submit-score-button");
  const pauseButton = document.getElementById("pause-button");

  const leaderboardList = document.getElementById("leaderboard-list");
  const scoreDialog = document.getElementById("score-dialog");
  const scoreForm = document.getElementById("score-form");
  const playerNameInput = document.getElementById("player-name");
  const finalScoreText = document.getElementById("final-score-text");
  const skipSubmitButton = document.getElementById("skip-submit");

  const skillDashButton = document.getElementById("skill-dash");
  const skillClearButton = document.getElementById("skill-clear");
  const skillUpgradeButton = document.getElementById("skill-upgrade");
  const skillDashCooldown = document.getElementById("skill-dash-cooldown");
  const skillClearCooldown = document.getElementById("skill-clear-cooldown");
  const skillDashLevel = document.getElementById("skill-dash-level");
  const skillClearLevel = document.getElementById("skill-clear-level");
  const upgradeCostDisplay = document.getElementById("upgrade-cost");

  const upgradeDialog = document.getElementById("upgrade-dialog");
  const closeUpgradeButton = document.getElementById("close-upgrade");
  const upgradeOptions = document.getElementById("upgrade-options");

  const powerUpStatus = document.getElementById("power-up-status");
  const touchLeft = document.getElementById("touch-left");
  const touchRight = document.getElementById("touch-right");

  const GAME_STATE = {
    IDLE: "idle",
    PLAYING: "playing",
    PAUSED: "paused",
    ENDED: "ended"
  };

  const ITEM_TYPES = {
    FISH: "fish",
    GOLDEN: "golden",
    BOMB: "bomb",
    SHIELD: "shield",
    DOUBLE_SCORE: "doubleScore",
    MAGNET: "magnet",
    SLOW_TIME: "slowTime"
  };

  const ENEMY_TYPES = {
    UFO: "ufo",
    BIRD: "bird",
    GHOST: "ghost"
  };

  const PHASE_CONFIG = {
    1: {
      name: "第一阶段",
      displayName: "悠闲夜市",
      duration: 30,
      baseSpawnInterval: 900,
      minSpawnInterval: 400,
      baseSpeed: 160,
      bombChance: 0.12,
      goldenChance: 0.12,
      powerUpChance: 0.10,
      enemyChance: 0,
      enemySpawnInterval: Infinity,
      maxItemsPerSecond: 3
    },
    2: {
      name: "第二阶段",
      displayName: "忙碌高峰",
      duration: 30,
      baseSpawnInterval: 700,
      minSpawnInterval: 250,
      baseSpeed: 200,
      bombChance: 0.18,
      goldenChance: 0.10,
      powerUpChance: 0.08,
      enemyChance: 0.08,
      enemySpawnInterval: 5000,
      maxItemsPerSecond: 4
    },
    3: {
      name: "第三阶段",
      displayName: "疯狂周末",
      duration: 30,
      baseSpawnInterval: 500,
      minSpawnInterval: 200,
      baseSpeed: 240,
      bombChance: 0.24,
      goldenChance: 0.08,
      powerUpChance: 0.06,
      enemyChance: 0.12,
      enemySpawnInterval: 3000,
      maxItemsPerSecond: 5
    }
  };

  const CONFIG = {
    width: canvas.width,
    height: canvas.height,
    baseDuration: 90,
    maxLives: 3,
    fishScore: 10,
    goldenFishScore: 25,
    goldenCoins: 5,
    bombPenalty: 1,
    playerSpeed: 420,
    dashSpeed: 800,
    dashDuration: 300,
    skillCooldowns: {
      dash: 10000,
      clearBombs: 15000
    },
    skillUpgradeCost: {
      base: 50,
      multiplier: 1.5
    },
    powerUpDurations: {
      shield: 5000,
      doubleScore: 8000,
      magnet: 6000,
      slowTime: 5000
    },
    fixedDeltaTime: 1 / 60,
    maxAccumulator: 0.1
  };

  let GAME = {
    state: GAME_STATE.IDLE,
    startingSession: false,
    sessionId: null,
    player: null,
    items: [],
    enemies: [],
    particles: [],
    backgroundData: null,
    score: 0,
    lives: CONFIG.maxLives,
    timeLeft: CONFIG.baseDuration,
    phase: 1,
    phaseTimeLeft: 30,
    elapsedAccumulator: 0,
    spawnAccumulator: 0,
    enemySpawnAccumulator: 0,
    lastFrameTime: 0,
    gameStartTime: 0,
    lastSecondTime: 0,
    animationId: 0,
    submittedScore: false,
    keys: { left: false, right: false },
    skills: {
      dash: {
        active: false,
        cooldownEnd: 0,
        lastUsed: 0,
        level: 1
      },
      clearBombs: {
        active: false,
        cooldownEnd: 0,
        lastUsed: 0,
        level: 1
      }
    },
    powerUps: {
      shield: { active: false, endTime: 0 },
      doubleScore: { active: false, endTime: 0 },
      magnet: { active: false, endTime: 0 },
      slowTime: { active: false, endTime: 0 }
    },
    combo: 0,
    maxCombo: 0,
    coins: 0,
    coinsEarned: 0,
    itemsCaught: { fish: 0, golden: 0, bomb: 0 },
    enemiesDefeated: 0,
    pendingNameSubmit: null
  };

  function createPlayer() {
    return {
      x: CONFIG.width / 2,
      y: CONFIG.height - 90,
      width: 88,
      height: 56,
      speed: CONFIG.playerSpeed,
      isDashing: false,
      dashEndTime: 0,
      targetX: CONFIG.width / 2
    };
  }

  function createBackgroundData() {
    const buildings = [];
    const windows = [];

    for (let i = 0; i < 14; i += 1) {
      const width = 42 + (i % 3) * 20;
      const height = 80 + (i % 5) * 22;
      const x = i * 66;
      const y = 420 - height;
      const isAlternate = i % 2 === 0;

      buildings.push({ x, y, width, height, isAlternate });

      const buildingWindows = [];
      for (let wy = y + 10; wy < y + height - 10; wy += 18) {
        for (let wx = x + 8; wx < x + width - 8; wx += 16) {
          const isLit = Math.random() > 0.72;
          buildingWindows.push({ x: wx, y: wy, isLit, flickerPhase: Math.random() * Math.PI * 2 });
        }
      }
      windows.push(...buildingWindows);
    }

    const clouds = Array.from({ length: 5 }, (_, index) => ({
      x: 120 + index * 170,
      y: 80 + (index % 3) * 50,
      width: 90 + Math.random() * 60,
      speed: 10 + Math.random() * 16,
      baseY: 80 + (index % 3) * 50
    }));

    const stars = Array.from({ length: 28 }, () => ({
      x: Math.random() * CONFIG.width,
      y: Math.random() * 180,
      radius: Math.random() * 2 + 1,
      twinklePhase: Math.random() * Math.PI * 2
    }));

    return { buildings, windows, clouds, stars };
  }

  function createParticle(x, y, color, type = "spark") {
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 100;
    
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 50,
      radius: type === "explosion" ? 4 + Math.random() * 6 : 2 + Math.random() * 3,
      color,
      life: 1,
      decay: 0.02 + Math.random() * 0.03,
      type
    };
  }

  function getPhaseConfig() {
    return PHASE_CONFIG[GAME.phase] || PHASE_CONFIG[1];
  }

  function spawnItem() {
    const phaseConfig = getPhaseConfig();
    const roll = Math.random();
    let type = ITEM_TYPES.FISH;

    if (roll > 1 - phaseConfig.bombChance) {
      type = ITEM_TYPES.BOMB;
    } else if (roll > 1 - phaseConfig.bombChance - phaseConfig.goldenChance) {
      type = ITEM_TYPES.GOLDEN;
    } else if (roll > 1 - phaseConfig.bombChance - phaseConfig.goldenChance - phaseConfig.powerUpChance) {
      const powerUpRoll = Math.random();
      if (powerUpRoll < 0.25) {
        type = ITEM_TYPES.SHIELD;
      } else if (powerUpRoll < 0.5) {
        type = ITEM_TYPES.DOUBLE_SCORE;
      } else if (powerUpRoll < 0.75) {
        type = ITEM_TYPES.MAGNET;
      } else {
        type = ITEM_TYPES.SLOW_TIME;
      }
    }

    const baseSpeed = phaseConfig.baseSpeed + Math.random() * 60;
    const speedMultiplier = GAME.powerUps.slowTime.active ? 0.5 : 1;

    GAME.items.push({
      type,
      x: 50 + Math.random() * (CONFIG.width - 100),
      y: -30,
      radius: type === ITEM_TYPES.BOMB ? 18 : 16,
      speed: (baseSpeed + (type === ITEM_TYPES.BOMB ? 40 : 0)) * speedMultiplier,
      baseSpeed: baseSpeed + (type === ITEM_TYPES.BOMB ? 40 : 0),
      drift: (Math.random() - 0.5) * 24,
      wobble: Math.random() * Math.PI * 2,
      rotation: 0,
      rotationSpeed: (Math.random() - 0.5) * 3
    });
  }

  function spawnEnemy() {
    const phaseConfig = getPhaseConfig();
    if (phaseConfig.enemyChance === 0) return;

    const roll = Math.random();
    let type = ENEMY_TYPES.UFO;
    if (roll > 0.66) {
      type = ENEMY_TYPES.GHOST;
    } else if (roll > 0.33) {
      type = ENEMY_TYPES.BIRD;
    }

    const enemyConfig = {
      [ENEMY_TYPES.UFO]: {
        radius: 24,
        speed: 100,
        horizontalSpeed: 80,
        damage: 1,
        points: 15,
        coins: 3
      },
      [ENEMY_TYPES.BIRD]: {
        radius: 20,
        speed: 140,
        horizontalSpeed: 60,
        damage: 1,
        points: 20,
        coins: 4
      },
      [ENEMY_TYPES.GHOST]: {
        radius: 22,
        speed: 80,
        horizontalSpeed: 100,
        damage: 1,
        points: 25,
        coins: 5
      }
    };

    const config = enemyConfig[type];
    const speedMultiplier = GAME.powerUps.slowTime.active ? 0.5 : 1;
    const startLeft = Math.random() > 0.5;

    GAME.enemies.push({
      type,
      x: startLeft ? -40 : CONFIG.width + 40,
      y: 100 + Math.random() * 150,
      radius: config.radius,
      speed: config.speed * speedMultiplier,
      baseSpeed: config.speed,
      horizontalSpeed: config.horizontalSpeed * (startLeft ? 1 : -1) * speedMultiplier,
      baseHorizontalSpeed: config.horizontalSpeed * (startLeft ? 1 : -1),
      damage: config.damage,
      points: config.points,
      coins: config.coins,
      targetY: CONFIG.height - 100,
      wobble: Math.random() * Math.PI * 2,
      rotation: 0
    });
  }

  function showComboPopup(combo, x, y) {
    if (combo < 5 || combo % 5 !== 0) return;

    const popup = document.createElement("div");
    popup.className = "combo-popup";
    popup.textContent = `${combo}连击!`;
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;

    const gameCard = canvas.parentElement;
    gameCard.appendChild(popup);

    setTimeout(() => {
      popup.remove();
    }, 1000);
  }

  function shakeScreen() {
    const gameCard = canvas.parentElement;
    gameCard.classList.add("shake");
    setTimeout(() => {
      gameCard.classList.remove("shake");
    }, 300);
  }

  function resetGame() {
    GAME.player = createPlayer();
    GAME.items = [];
    GAME.enemies = [];
    GAME.particles = [];
    GAME.score = 0;
    GAME.lives = CONFIG.maxLives;
    GAME.timeLeft = CONFIG.baseDuration;
    GAME.phase = 1;
    GAME.phaseTimeLeft = PHASE_CONFIG[1].duration;
    GAME.elapsedAccumulator = 0;
    GAME.spawnAccumulator = 0;
    GAME.enemySpawnAccumulator = 0;
    GAME.lastFrameTime = 0;
    GAME.gameStartTime = 0;
    GAME.lastSecondTime = 0;
    GAME.submittedScore = false;
    GAME.state = GAME_STATE.IDLE;
    GAME.combo = 0;
    GAME.maxCombo = 0;
    GAME.coins = 0;
    GAME.coinsEarned = 0;
    GAME.itemsCaught = { fish: 0, golden: 0, bomb: 0 };
    GAME.enemiesDefeated = 0;
    GAME.pendingNameSubmit = null;

    Object.keys(GAME.skills).forEach(key => {
      GAME.skills[key] = {
        active: false,
        cooldownEnd: 0,
        lastUsed: 0,
        level: 1
      };
    });

    Object.keys(GAME.powerUps).forEach(key => {
      GAME.powerUps[key] = { active: false, endTime: 0 };
    });

    if (!GAME.backgroundData) {
      GAME.backgroundData = createBackgroundData();
    }

    updateHud();
    updateSkillUI();
    updatePowerUpUI();
    showStartOverlay();
  }

  function showStartOverlay() {
    startOverlay.classList.remove("hidden");
    pauseOverlay.classList.add("hidden");
    gameoverOverlay.classList.add("hidden");
  }

  function showPauseOverlay() {
    pauseScore.textContent = GAME.score;
    pauseTime.textContent = `${GAME.timeLeft}s`;
    pauseOverlay.classList.remove("hidden");
  }

  function hidePauseOverlay() {
    pauseOverlay.classList.add("hidden");
  }

  function showGameOverOverlay(isWin) {
    gameoverTag.textContent = isWin ? "TIME'S UP!" : "GAME OVER";
    gameoverTitle.textContent = isWin ? "时间到！" : "游戏结束";

    finalScoreDisplay.textContent = GAME.score;
    finalMaxCombo.textContent = `${GAME.maxCombo}x`;
    finalFishCaught.textContent = GAME.itemsCaught.fish;
    finalGoldenCaught.textContent = GAME.itemsCaught.golden;
    finalCoinsEarned.textContent = GAME.coinsEarned;

    startOverlay.classList.add("hidden");
    pauseOverlay.classList.add("hidden");
    gameoverOverlay.classList.remove("hidden");
  }

  function hideGameOverOverlay() {
    gameoverOverlay.classList.add("hidden");
  }

  async function createSession() {
    const response = await fetch("/api/session", {
      method: "POST"
    });

    const payload = await response.json();
    if (!response.ok || !payload.sessionId) {
      throw new Error(payload.message || "Failed to create session");
    }

    return payload.sessionId;
  }

  async function closeSession() {
    if (!GAME.sessionId) {
      return;
    }

    try {
      await fetch("/api/session/close", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sessionId: GAME.sessionId })
      });
    } catch (error) {
      console.error("Session close failed:", error);
    } finally {
      GAME.sessionId = null;
    }
  }

  async function startGame() {
    if (GAME.state === GAME_STATE.PLAYING || GAME.startingSession) {
      return;
    }

    GAME.startingSession = true;
    startButton.disabled = true;
    overlayStartButton.disabled = true;

    try {
      if (GAME.sessionId) {
        await closeSession();
      }

      GAME.sessionId = await createSession();
    } catch (error) {
      console.error("Failed to start session", error);
      GAME.sessionId = null;
      GAME.startingSession = false;
      startButton.disabled = false;
      overlayStartButton.disabled = false;
      return;
    }

    resetGame();
    GAME.state = GAME_STATE.PLAYING;
    startOverlay.classList.add("hidden");
    hideGameOverOverlay();
    
    const now = performance.now();
    GAME.lastFrameTime = now;
    GAME.gameStartTime = now;
    GAME.lastSecondTime = now;

    GAME.startingSession = false;
    startButton.disabled = false;
    overlayStartButton.disabled = false;
    GAME.animationId = requestAnimationFrame(gameLoop);
  }

  function pauseGame() {
    if (GAME.state !== GAME_STATE.PLAYING) return;
    GAME.state = GAME_STATE.PAUSED;
    cancelAnimationFrame(GAME.animationId);
    showPauseOverlay();
  }

  function resumeGame() {
    if (GAME.state !== GAME_STATE.PAUSED) return;
    GAME.state = GAME_STATE.PLAYING;
    hidePauseOverlay();
    
    const now = performance.now();
    GAME.lastFrameTime = now;
    GAME.lastSecondTime = now;
    
    GAME.animationId = requestAnimationFrame(gameLoop);
  }

  function endGame(byTimeout = false) {
    GAME.state = GAME_STATE.ENDED;
    cancelAnimationFrame(GAME.animationId);
    showGameOverOverlay(byTimeout);
  }

  function updateHud() {
    scoreValue.textContent = String(GAME.score);
    livesValue.textContent = String(GAME.lives);
    timeValue.textContent = `${GAME.timeLeft}s`;
    comboValue.textContent = `${GAME.combo}x`;
    coinsValue.textContent = String(GAME.coins);

    const phaseConfig = getPhaseConfig();
    levelValue.textContent = phaseConfig.displayName;
  }

  function updateSkillUI() {
    const now = performance.now();
    
    if (GAME.skills.dash.cooldownEnd > now) {
      const remaining = GAME.skills.dash.cooldownEnd - now;
      const progress = remaining / CONFIG.skillCooldowns.dash;
      skillDashCooldown.style.height = `${progress * 100}%`;
      skillDashButton.classList.add("on-cooldown");
    } else {
      skillDashCooldown.style.height = "0%";
      skillDashButton.classList.remove("on-cooldown");
    }

    if (GAME.skills.clearBombs.cooldownEnd > now) {
      const remaining = GAME.skills.clearBombs.cooldownEnd - now;
      const progress = remaining / CONFIG.skillCooldowns.clearBombs;
      skillClearCooldown.style.height = `${progress * 100}%`;
      skillClearButton.classList.add("on-cooldown");
    } else {
      skillClearCooldown.style.height = "0%";
      skillClearButton.classList.remove("on-cooldown");
    }

    skillDashLevel.textContent = `Lv.${GAME.skills.dash.level}`;
    skillClearLevel.textContent = `Lv.${GAME.skills.clearBombs.level}`;

    const upgradeCost = Math.floor(
      CONFIG.skillUpgradeCost.base * 
      Math.pow(CONFIG.skillUpgradeCost.multiplier, Math.max(GAME.skills.dash.level, GAME.skills.clearBombs.level) - 1)
    );
    upgradeCostDisplay.textContent = `${upgradeCost}💰`;
  }

  function updatePowerUpUI() {
    const now = performance.now();
    let html = "";

    Object.entries(GAME.powerUps).forEach(([key, value]) => {
      if (value.active && value.endTime > now) {
        const remaining = Math.ceil((value.endTime - now) / 1000);
        const icons = {
          shield: "🛡️",
          doubleScore: "✨",
          magnet: "🧲",
          slowTime: "⏰"
        };
        html += `<div class="active-power-up">
          <span>${icons[key]}</span>
          <span>${remaining}s</span>
        </div>`;
      }
    });

    powerUpStatus.innerHTML = html;
  }

  function getUpgradeCost(skillLevel) {
    return Math.floor(
      CONFIG.skillUpgradeCost.base * 
      Math.pow(CONFIG.skillUpgradeCost.multiplier, skillLevel - 1)
    );
  }

  function upgradeSkill(skillKey) {
    const skill = GAME.skills[skillKey];
    if (!skill) return false;

    const cost = getUpgradeCost(skill.level);
    if (GAME.coins < cost) return false;

    GAME.coins -= cost;
    skill.level += 1;

    if (skillKey === "dash") {
      CONFIG.dashSpeed = 800 + (skill.level - 1) * 100;
      CONFIG.dashDuration = 300 + (skill.level - 1) * 50;
    } else if (skillKey === "clearBombs") {
      CONFIG.skillCooldowns.clearBombs = Math.max(8000, 15000 - (skill.level - 1) * 2000);
    }

    updateHud();
    updateSkillUI();
    return true;
  }

  function showUpgradeDialog() {
    const dashLevel = GAME.skills.dash.level;
    const clearLevel = GAME.skills.clearBombs.level;
    const dashCost = getUpgradeCost(dashLevel);
    const clearCost = getUpgradeCost(clearLevel);

    document.getElementById("dash-current-level").textContent = dashLevel;
    document.getElementById("clear-current-level").textContent = clearLevel;
    document.getElementById("dash-upgrade-cost").textContent = `${dashCost}💰`;
    document.getElementById("clear-upgrade-cost").textContent = `${clearCost}💰`;

    const dashOption = upgradeOptions.querySelector('[data-skill="dash"]');
    const clearOption = upgradeOptions.querySelector('[data-skill="clearBombs"]');

    dashOption.disabled = GAME.coins < dashCost;
    clearOption.disabled = GAME.coins < clearCost;

    if (upgradeDialog.open) {
      return;
    }

    if (typeof upgradeDialog.showModal === "function") {
      upgradeDialog.showModal();
    }
  }

  function useDash() {
    const now = performance.now();
    if (GAME.skills.dash.cooldownEnd > now || GAME.state !== GAME_STATE.PLAYING) return;

    GAME.player.isDashing = true;
    GAME.player.dashEndTime = now + CONFIG.dashDuration;
    GAME.skills.dash.cooldownEnd = now + CONFIG.skillCooldowns.dash;
    GAME.skills.dash.lastUsed = now;

    for (let i = 0; i < 10; i++) {
      GAME.particles.push(createParticle(GAME.player.x, GAME.player.y, "#ffd166", "spark"));
    }
  }

  function useClearBombs() {
    const now = performance.now();
    if (GAME.skills.clearBombs.cooldownEnd > now || GAME.state !== GAME_STATE.PLAYING) return;

    GAME.skills.clearBombs.cooldownEnd = now + CONFIG.skillCooldowns.clearBombs;
    GAME.skills.clearBombs.lastUsed = now;

    const clearLevel = GAME.skills.clearBombs.level;
    let bombsCleared = 0;

    GAME.items = GAME.items.filter(item => {
      if (item.type === ITEM_TYPES.BOMB) {
        for (let i = 0; i < 15; i++) {
          GAME.particles.push(createParticle(item.x, item.y, "#ff5f5f", "explosion"));
        }
        if (clearLevel >= 2) {
          GAME.score += 5;
        }
        bombsCleared++;
        return false;
      }
      return true;
    });

    if (bombsCleared > 0) {
      sendSessionUpdate("bombsCleared", null, { count: bombsCleared });
    }

    GAME.enemies = GAME.enemies.filter(enemy => {
      if (clearLevel >= 3) {
        for (let i = 0; i < 20; i++) {
          GAME.particles.push(createParticle(enemy.x, enemy.y, "#ff5f5f", "explosion"));
        }
        GAME.score += enemy.points;
        GAME.coins += Math.floor(enemy.coins / 2);
        GAME.enemiesDefeated += 1;
        sendSessionUpdate("enemyDefeated");
        return false;
      }
      return true;
    });
  }

  function activatePowerUp(type) {
    const now = performance.now();
    const duration = CONFIG.powerUpDurations[type];
    
    if (GAME.powerUps[type]) {
      GAME.powerUps[type].active = true;
      GAME.powerUps[type].endTime = Math.max(GAME.powerUps[type].endTime, now) + duration;
    }

    sendSessionUpdate("powerUpUsed");
  }

  async function sendSessionUpdate(updateType, itemType = null, extraData = null) {
    if (!GAME.sessionId) return;
    
    try {
      const body = {
        sessionId: GAME.sessionId,
        updateType
      };
      if (itemType) {
        body.itemType = itemType;
      }
      if (extraData && typeof extraData === "object") {
        Object.assign(body, extraData);
      }

      await fetch("/api/session/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      console.error("Session update failed:", error);
    }
  }

  function handleItemCollision(item) {
    const colorMap = {
      [ITEM_TYPES.FISH]: "#7ae7c7",
      [ITEM_TYPES.GOLDEN]: "#ffd166",
      [ITEM_TYPES.BOMB]: "#ff5f5f",
      [ITEM_TYPES.SHIELD]: "#7ae7c7",
      [ITEM_TYPES.DOUBLE_SCORE]: "#ffd166",
      [ITEM_TYPES.MAGNET]: "#7ae7c7",
      [ITEM_TYPES.SLOW_TIME]: "#ffd166"
    };

    for (let i = 0; i < 8; i++) {
      GAME.particles.push(createParticle(item.x, item.y, colorMap[item.type] || "#fff", "spark"));
    }

    let scoreGain = 0;

    switch (item.type) {
      case ITEM_TYPES.FISH:
        scoreGain = CONFIG.fishScore;
        GAME.combo++;
        GAME.itemsCaught.fish++;
        sendSessionUpdate("itemCaught", "fish");
        break;
      case ITEM_TYPES.GOLDEN:
        scoreGain = CONFIG.goldenFishScore;
        GAME.combo += 2;
        GAME.itemsCaught.golden++;
        GAME.coins += CONFIG.goldenCoins;
        GAME.coinsEarned += CONFIG.goldenCoins;
        sendSessionUpdate("itemCaught", "golden");
        break;
      case ITEM_TYPES.BOMB:
        if (!GAME.powerUps.shield.active) {
          GAME.lives -= 1;
          GAME.combo = 0;
          GAME.itemsCaught.bomb++;
          shakeScreen();
          sendSessionUpdate("itemCaught", "bomb");
        }
        break;
      case ITEM_TYPES.SHIELD:
        activatePowerUp("shield");
        break;
      case ITEM_TYPES.DOUBLE_SCORE:
        activatePowerUp("doubleScore");
        break;
      case ITEM_TYPES.MAGNET:
        activatePowerUp("magnet");
        break;
      case ITEM_TYPES.SLOW_TIME:
        activatePowerUp("slowTime");
        break;
    }

    if (GAME.combo > GAME.maxCombo) {
      GAME.maxCombo = GAME.combo;
      if (GAME.combo >= 5 && GAME.combo % 5 === 0) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = CONFIG.width / rect.width;
        const scaleY = CONFIG.height / rect.height;
        const popupX = (GAME.player.x / scaleX) + rect.left;
        const popupY = (GAME.player.y / scaleY) + rect.top - 50;
        showComboPopup(GAME.combo, popupX, popupY);
      }
    }

    if (scoreGain > 0) {
      const comboMultiplier = 1 + Math.floor(GAME.combo / 5) * 0.1;
      const doubleMultiplier = GAME.powerUps.doubleScore.active ? 2 : 1;
      GAME.score += Math.floor(scoreGain * comboMultiplier * doubleMultiplier);
    }

    updateHud();
  }

  function handleEnemyCollision(enemy) {
    for (let i = 0; i < 12; i++) {
      GAME.particles.push(createParticle(enemy.x, enemy.y, "#ff5f5f", "explosion"));
    }

    if (GAME.player.isDashing || GAME.skills.dash.level >= 3) {
      GAME.score += enemy.points;
      GAME.coins += enemy.coins;
      GAME.coinsEarned += enemy.coins;
      GAME.enemiesDefeated += 1;
      sendSessionUpdate("enemyDefeated");
    } else if (!GAME.powerUps.shield.active) {
      GAME.lives -= enemy.damage;
      GAME.combo = 0;
      shakeScreen();
    } else {
      GAME.enemiesDefeated += 1;
      sendSessionUpdate("enemyDefeated");
    }

    updateHud();
  }

  function updatePhase() {
    const totalTimePassed = CONFIG.baseDuration - GAME.timeLeft;
    
    let newPhase = 1;
    if (totalTimePassed >= PHASE_CONFIG[1].duration + PHASE_CONFIG[2].duration) {
      newPhase = 3;
    } else if (totalTimePassed >= PHASE_CONFIG[1].duration) {
      newPhase = 2;
    }

    if (newPhase !== GAME.phase) {
      GAME.phase = newPhase;
      GAME.phaseTimeLeft = PHASE_CONFIG[newPhase].duration;
      
      for (let i = 0; i < 30; i++) {
        GAME.particles.push(createParticle(
          CONFIG.width / 2 + (Math.random() - 0.5) * 200,
          CONFIG.height / 2 + (Math.random() - 0.5) * 100,
          newPhase === 2 ? "#ffd166" : "#ff5f5f",
          "explosion"
        ));
      }

      updateHud();
    }
  }

  function update(deltaSeconds) {
    const now = performance.now();
    const player = GAME.player;
    const phaseConfig = getPhaseConfig();

    if (GAME.player.isDashing && now > GAME.player.dashEndTime) {
      GAME.player.isDashing = false;
    }

    const dashLevel = GAME.skills.dash.level;
    const currentDashSpeed = CONFIG.dashSpeed + (dashLevel - 1) * 50;
    const currentDashDuration = CONFIG.dashDuration + (dashLevel - 1) * 50;
    const currentSpeed = player.isDashing ? currentDashSpeed : player.speed;
    
    if (GAME.keys.left) {
      player.x -= currentSpeed * deltaSeconds;
    }
    if (GAME.keys.right) {
      player.x += currentSpeed * deltaSeconds;
    }

    player.x = Math.max(player.width / 2, Math.min(CONFIG.width - player.width / 2, player.x));

    updatePhase();

    const spawnInterval = Math.max(
      phaseConfig.minSpawnInterval,
      phaseConfig.baseSpawnInterval - 
        (1 - GAME.phaseTimeLeft / phaseConfig.duration) * 
        (phaseConfig.baseSpawnInterval - phaseConfig.minSpawnInterval)
    );

    GAME.spawnAccumulator += deltaSeconds * 1000;
    if (GAME.spawnAccumulator >= spawnInterval) {
      GAME.spawnAccumulator = 0;
      spawnItem();
    }

    GAME.enemySpawnAccumulator += deltaSeconds * 1000;
    if (GAME.enemySpawnAccumulator >= phaseConfig.enemySpawnInterval && phaseConfig.enemyChance > 0) {
      GAME.enemySpawnAccumulator = 0;
      if (Math.random() < phaseConfig.enemyChance) {
        spawnEnemy();
      }
    }

    if (GAME.powerUps.slowTime.active && now > GAME.powerUps.slowTime.endTime) {
      GAME.powerUps.slowTime.active = false;
      GAME.items.forEach(item => {
        item.speed = item.baseSpeed;
      });
      GAME.enemies.forEach(enemy => {
        enemy.speed = enemy.baseSpeed;
        enemy.horizontalSpeed = enemy.baseHorizontalSpeed;
      });
    }

    if (GAME.powerUps.magnet.active) {
      GAME.items.forEach(item => {
        if (item.type !== ITEM_TYPES.BOMB) {
          const dx = player.x - item.x;
          const dy = player.y - item.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 1 && dist < 250) {
            const magnetStrength = 1 + (GAME.phase - 1) * 0.5;
            item.x += (dx / dist) * 250 * magnetStrength * deltaSeconds;
            item.y += (dy / dist) * 150 * magnetStrength * deltaSeconds;
          }
        }
      });
    }

    const playerBox = {
      left: player.x - player.width / 2,
      right: player.x + player.width / 2,
      top: player.y - player.height / 2,
      bottom: player.y + player.height / 2
    };

    GAME.items = GAME.items.filter((item) => {
      const speedMultiplier = GAME.powerUps.slowTime.active ? 0.5 : 1;
      item.y += item.baseSpeed * speedMultiplier * deltaSeconds;
      item.x += Math.sin(item.wobble + item.y * 0.03) * item.drift * deltaSeconds;
      item.rotation += item.rotationSpeed * deltaSeconds;

      const caught =
        item.x + item.radius > playerBox.left &&
        item.x - item.radius < playerBox.right &&
        item.y + item.radius > playerBox.top &&
        item.y - item.radius < playerBox.bottom;

      if (caught) {
        handleItemCollision(item);

        if (GAME.lives <= 0) {
          GAME.lives = 0;
          updateHud();
          endGame(false);
        }

        return false;
      }

      if (item.y - item.radius > CONFIG.height) {
        if (item.type !== ITEM_TYPES.BOMB) {
          if (!GAME.powerUps.shield.active) {
            GAME.lives -= 1;
            GAME.combo = 0;
            shakeScreen();
          }
          updateHud();
          if (GAME.lives <= 0) {
            GAME.lives = 0;
            updateHud();
            endGame(false);
          }
        }

        return false;
      }

      return true;
    });

    GAME.enemies = GAME.enemies.filter((enemy) => {
      const speedMultiplier = GAME.powerUps.slowTime.active ? 0.5 : 1;
      
      enemy.y += enemy.baseSpeed * speedMultiplier * deltaSeconds;
      enemy.x += enemy.horizontalSpeed * speedMultiplier * deltaSeconds;
      enemy.wobble += deltaSeconds * 3;
      enemy.rotation += deltaSeconds * 2;

      if (enemy.x < -60 || enemy.x > CONFIG.width + 60) {
        return false;
      }

      const caught =
        enemy.x + enemy.radius > playerBox.left &&
        enemy.x - enemy.radius < playerBox.right &&
        enemy.y + enemy.radius > playerBox.top &&
        enemy.y - enemy.radius < playerBox.bottom;

      if (caught) {
        handleEnemyCollision(enemy);

        if (GAME.lives <= 0) {
          GAME.lives = 0;
          updateHud();
          endGame(false);
        }

        return false;
      }

      if (enemy.y - enemy.radius > CONFIG.height) {
        return false;
      }

      return true;
    });

    GAME.particles = GAME.particles.filter(particle => {
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;
      particle.vy += 200 * deltaSeconds;
      particle.life -= particle.decay;
      return particle.life > 0;
    });

    Object.keys(GAME.powerUps).forEach(key => {
      if (GAME.powerUps[key].active && now > GAME.powerUps[key].endTime) {
        GAME.powerUps[key].active = false;
      }
    });

    updateSkillUI();
    updatePowerUpUI();
    updateHud();
  }

  function drawSkyline() {
    if (!GAME.backgroundData) return;

    const { buildings, windows } = GAME.backgroundData;
    const time = performance.now() / 1000;

    ctx.fillStyle = "#15263e";
    ctx.fillRect(0, 420, CONFIG.width, 120);

    buildings.forEach(building => {
      ctx.fillStyle = building.isAlternate ? "#1d3152" : "#223b61";
      ctx.fillRect(building.x, building.y, building.width, building.height);
    });

    windows.forEach(window => {
      const flicker = Math.sin(time * 2 + window.flickerPhase) * 0.5 + 0.5;
      if (window.isLit) {
        ctx.fillStyle = `rgba(255, 209, 102, ${0.8 + flicker * 0.2})`;
      } else {
        ctx.fillStyle = `rgba(255, 209, 102, ${0.1 + flicker * 0.08})`;
      }
      ctx.fillRect(window.x, window.y, 7, 9);
    });
  }

  function drawBackground() {
    if (!GAME.backgroundData) return;

    const { clouds, stars } = GAME.backgroundData;
    const time = performance.now() / 1000;

    ctx.clearRect(0, 0, CONFIG.width, CONFIG.height);

    const gradient = ctx.createLinearGradient(0, 0, 0, CONFIG.height);
    gradient.addColorStop(0, "#243d69");
    gradient.addColorStop(0.55, "#395f96");
    gradient.addColorStop(1, "#f08d57");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);

    ctx.fillStyle = "#ffe6a7";
    ctx.beginPath();
    ctx.arc(120, 100, 44, 0, Math.PI * 2);
    ctx.fill();

    stars.forEach((star) => {
      const twinkle = Math.sin(time * 3 + star.twinklePhase) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + twinkle * 0.5})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fill();
    });

    clouds.forEach((cloud) => {
      cloud.x -= cloud.speed * 0.016;
      if (cloud.x < -cloud.width) {
        cloud.x = CONFIG.width + cloud.width;
        cloud.y = 50 + Math.random() * 120;
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
      ctx.beginPath();
      ctx.ellipse(cloud.x, cloud.y, cloud.width * 0.4, 22, 0, 0, Math.PI * 2);
      ctx.ellipse(cloud.x + 36, cloud.y + 10, cloud.width * 0.32, 18, 0, 0, Math.PI * 2);
      ctx.ellipse(cloud.x - 34, cloud.y + 6, cloud.width * 0.28, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    drawSkyline();

    ctx.fillStyle = "#2b201c";
    ctx.fillRect(0, CONFIG.height - 60, CONFIG.width, 60);
    ctx.fillStyle = "#3c2d26";
    ctx.fillRect(0, CONFIG.height - 68, CONFIG.width, 8);
  }

  function drawCat(player) {
    ctx.save();
    ctx.translate(player.x, player.y);

    if (GAME.powerUps.shield.active) {
      ctx.strokeStyle = "rgba(122, 231, 199, 0.6)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, player.width / 2 + 15, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (GAME.powerUps.doubleScore.active) {
      ctx.shadowColor = "#ffd166";
      ctx.shadowBlur = 15;
    }

    if (player.isDashing) {
      ctx.shadowColor = "#ffd166";
      ctx.shadowBlur = 25;
      
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.3 - i * 0.08;
        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.ellipse(-i * 20, 0, player.width / 2 - i * 5, player.height / 2 - i * 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = "#ff8c42";
    ctx.beginPath();
    ctx.ellipse(0, 0, player.width / 2, player.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1b1b1b";
    ctx.beginPath();
    ctx.moveTo(-15, -10);
    ctx.lineTo(-5, -25);
    ctx.lineTo(5, -10);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(15, -10);
    ctx.lineTo(5, -25);
    ctx.lineTo(-5, -10);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-5, -5);
    ctx.lineTo(0, 15);
    ctx.lineTo(5, -5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#fff4da";
    ctx.beginPath();
    ctx.ellipse(0, 8, 24, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1b1b1b";
    ctx.beginPath();
    ctx.ellipse(-14, -6, 5, 5, 0, 0, Math.PI * 2);
    ctx.arc(14, -6, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-15, -8, 2, 0, Math.PI * 2);
    ctx.arc(13, -8, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#fff4da";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-8, 8);
    ctx.lineTo(-32, 2);
    ctx.moveTo(-8, 12);
    ctx.lineTo(-32, 14);
    ctx.moveTo(8, 8);
    ctx.lineTo(32, 2);
    ctx.moveTo(8, 12);
    ctx.lineTo(32, 14);
    ctx.stroke();

    ctx.fillStyle = "#ff5f5f";
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(-5, 10);
    ctx.lineTo(5, 10);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawFish(item, color) {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rotation);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(28, -10);
    ctx.lineTo(28, 10);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#11203b";
    ctx.beginPath();
    ctx.arc(-8, -2, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawBomb(item) {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rotation * 0.5);

    ctx.fillStyle = "#1c1c24";
    ctx.beginPath();
    ctx.arc(0, 0, item.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#2a2a36";
    ctx.beginPath();
    ctx.arc(-5, -5, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#8b4513";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.quadraticCurveTo(8, -25, 10, -28);
    ctx.stroke();

    const time = performance.now() / 1000;
    const sparkle = Math.sin(time * 10) * 0.5 + 0.5;

    ctx.fillStyle = `rgba(255, 183, 3, ${0.5 + sparkle * 0.5})`;
    ctx.beginPath();
    ctx.arc(12, -30, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 100, 0, ${0.3 + sparkle * 0.3})`;
    ctx.beginPath();
    ctx.arc(12, -30, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawPowerUp(item) {
    ctx.save();
    ctx.translate(item.x, item.y);
    
    const time = performance.now() / 1000;
    const pulse = Math.sin(time * 4) * 0.2 + 1;
    
    ctx.scale(pulse, pulse);

    const colors = {
      [ITEM_TYPES.SHIELD]: "#7ae7c7",
      [ITEM_TYPES.DOUBLE_SCORE]: "#ffd166",
      [ITEM_TYPES.MAGNET]: "#7ae7c7",
      [ITEM_TYPES.SLOW_TIME]: "#ffd166"
    };

    ctx.fillStyle = `rgba(0, 0, 0, 0.3)`;
    ctx.beginPath();
    ctx.arc(2, 2, item.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors[item.type] || "#fff";
    ctx.beginPath();
    ctx.arc(0, 0, item.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.beginPath();
    ctx.arc(-4, -4, item.radius * 0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.font = `bold ${item.radius * 1.2}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    const icons = {
      [ITEM_TYPES.SHIELD]: "🛡",
      [ITEM_TYPES.DOUBLE_SCORE]: "✦",
      [ITEM_TYPES.MAGNET]: "⊕",
      [ITEM_TYPES.SLOW_TIME]: "⏱"
    };
    ctx.fillText(icons[item.type] || "★", 0, 0);

    ctx.restore();
  }

  function drawEnemy(enemy) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);

    const time = performance.now() / 1000;
    const wobble = Math.sin(enemy.wobble) * 5;
    
    switch (enemy.type) {
      case ENEMY_TYPES.UFO:
        ctx.fillStyle = "#8b5cf6";
        ctx.beginPath();
        ctx.ellipse(0, wobble * 0.3, enemy.radius, enemy.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = "#a78bfa";
        ctx.beginPath();
        ctx.arc(0, wobble * 0.3 - 5, enemy.radius * 0.6, Math.PI, 0);
        ctx.fill();

        ctx.fillStyle = "#ffd166";
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2 + time * 2;
          const x = Math.cos(angle) * enemy.radius * 0.8;
          const y = Math.sin(angle) * enemy.radius * 0.2 + wobble * 0.3;
          ctx.beginPath();
          ctx.arc(x, y + 5, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        break;

      case ENEMY_TYPES.BIRD:
        ctx.rotate(enemy.rotation * 0.5);
        
        ctx.fillStyle = "#3b82f6";
        ctx.beginPath();
        ctx.ellipse(0, 0, enemy.radius, enemy.radius * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();

        const wingAngle = Math.sin(time * 10) * 0.5;
        ctx.fillStyle = "#60a5fa";
        ctx.save();
        ctx.rotate(wingAngle);
        ctx.beginPath();
        ctx.ellipse(-enemy.radius * 0.8, -5, enemy.radius * 0.5, enemy.radius * 0.3, -0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.rotate(-wingAngle);
        ctx.beginPath();
        ctx.ellipse(-enemy.radius * 0.8, 5, enemy.radius * 0.5, enemy.radius * 0.3, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.moveTo(enemy.radius * 0.8, 0);
        ctx.lineTo(enemy.radius * 1.3, -3);
        ctx.lineTo(enemy.radius * 1.3, 3);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(enemy.radius * 0.3, -3, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.arc(enemy.radius * 0.35, -3, 2, 0, Math.PI * 2);
        ctx.fill();
        break;

      case ENEMY_TYPES.GHOST:
        const floatY = Math.sin(time * 3) * 5;
        
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = "#e0e0e0";
        ctx.beginPath();
        ctx.arc(0, floatY, enemy.radius, Math.PI, 0);
        ctx.lineTo(enemy.radius, floatY + enemy.radius * 0.8);
        
        for (let i = 0; i < 4; i++) {
          const waveX = enemy.radius - (i * enemy.radius * 0.5);
          const waveY = floatY + enemy.radius * 0.8 + Math.sin(time * 5 + i) * 5;
          if (i === 0) {
            ctx.lineTo(waveX, waveY);
          } else {
            ctx.quadraticCurveTo(waveX + enemy.radius * 0.25, waveY - 8, waveX, waveY);
          }
        }
        ctx.lineTo(-enemy.radius, floatY + enemy.radius * 0.8);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.ellipse(-8, floatY - 2, 5, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(8, floatY - 2, 5, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(-9, floatY - 4, 2, 0, Math.PI * 2);
        ctx.arc(7, floatY - 4, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#333";
        ctx.beginPath();
        ctx.ellipse(0, floatY + 8, 6, 4, 0, 0, Math.PI);
        ctx.fill();
        break;
    }

    ctx.restore();
  }

  function drawItems() {
    GAME.items.forEach((item) => {
      switch (item.type) {
        case ITEM_TYPES.BOMB:
          drawBomb(item);
          break;
        case ITEM_TYPES.GOLDEN:
          drawFish(item, "#ffd166");
          break;
        case ITEM_TYPES.FISH:
          drawFish(item, "#7ae7c7");
          break;
        default:
          drawPowerUp(item);
          break;
      }
    });
  }

  function drawEnemies() {
    GAME.enemies.forEach((enemy) => {
      drawEnemy(enemy);
    });
  }

  function drawParticles() {
    GAME.particles.forEach(particle => {
      ctx.save();
      ctx.globalAlpha = particle.life;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius * particle.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function drawGroundDetails() {
    ctx.fillStyle = "rgba(255, 244, 218, 0.18)";
    for (let i = 0; i < 9; i += 1) {
      ctx.fillRect(18 + i * 100, CONFIG.height - 58, 64, 4);
    }
  }

  function render() {
    drawBackground();
    drawGroundDetails();
    drawItems();
    drawEnemies();
    drawParticles();
    drawCat(GAME.player);
  }

  function gameLoop(timestamp) {
    if (GAME.state !== GAME_STATE.PLAYING) {
      render();
      return;
    }

    const rawDelta = timestamp - GAME.lastFrameTime;
    const deltaSeconds = Math.min(rawDelta / 1000, CONFIG.maxAccumulator);
    GAME.lastFrameTime = timestamp;

    GAME.elapsedAccumulator += deltaSeconds;
    let fixedUpdates = 0;

    while (GAME.elapsedAccumulator >= CONFIG.fixedDeltaTime && fixedUpdates < 5) {
      update(CONFIG.fixedDeltaTime);
      GAME.elapsedAccumulator -= CONFIG.fixedDeltaTime;
      fixedUpdates++;
    }

    const elapsedSinceLastSecond = timestamp - GAME.lastSecondTime;
    if (elapsedSinceLastSecond >= 1000) {
      const secondsPassed = Math.floor(elapsedSinceLastSecond / 1000);
      GAME.timeLeft = Math.max(0, GAME.timeLeft - secondsPassed);
      GAME.phaseTimeLeft = Math.max(0, GAME.phaseTimeLeft - secondsPassed);
      GAME.lastSecondTime += secondsPassed * 1000;
      
      sendSessionUpdate("heartbeat");
      updateHud();

      if (GAME.timeLeft <= 0) {
        GAME.timeLeft = 0;
        updateHud();
        endGame(true);
        return;
      }
    }

    render();

    if (GAME.state === GAME_STATE.PLAYING) {
      GAME.animationId = requestAnimationFrame(gameLoop);
    }
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }

    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function loadConfig() {
    try {
      const response = await fetch("/api/game-config");
      const data = await response.json();
      CONFIG.baseDuration = data.durationSeconds ?? CONFIG.baseDuration;
      CONFIG.maxLives = data.maxLives ?? CONFIG.maxLives;
      if (GAME.state === GAME_STATE.IDLE) {
        resetGame();
      }
    } catch (error) {
      console.error("Failed to load config", error);
    }
  }

  async function loadLeaderboard() {
    leaderboardList.innerHTML = "<li>加载中...</li>";

    try {
      const response = await fetch("/api/leaderboard");
      const data = await response.json();
      const entries = data.leaderboard || [];

      if (!entries.length) {
        leaderboardList.innerHTML = "<li>还没有记录，去拿第一名吧！</li>";
        return;
      }

      leaderboardList.innerHTML = entries
        .map(
          (entry) => `
            <li>
              <div class="leaderboard-rank rank-${entry.rank}">#${entry.rank}</div>
              <div>
                <span class="leaderboard-name">${escapeHtml(entry.name)}</span>
                <span class="leaderboard-date">${formatDate(entry.createdAt)}</span>
              </div>
              <div class="leaderboard-score">${entry.score}</div>
            </li>
          `
        )
        .join("");
    } catch (error) {
      console.error("Failed to load leaderboard", error);
      leaderboardList.innerHTML = "<li>排行榜加载失败</li>";
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function submitScore(name, score) {
    const response = await fetch("/api/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        name, 
        score,
        sessionId: GAME.sessionId
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "Score submission failed");
    }

    GAME.submittedScore = true;
    GAME.sessionId = null;
    await loadLeaderboard();
  }

  function openScoreSubmitDialog() {
    finalScoreText.textContent = `你的得分：${GAME.score}`;
    playerNameInput.value = "";
    if (typeof scoreDialog.showModal === "function" && !GAME.submittedScore) {
      scoreDialog.showModal();
    }
  }

  function onKeyChange(event, pressed) {
    if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") {
      GAME.keys.left = pressed;
    }

    if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") {
      GAME.keys.right = pressed;
    }

    if (pressed && event.key.toLowerCase() === "q") {
      useDash();
    }

    if (pressed && event.key.toLowerCase() === "e") {
      useClearBombs();
    }

    if (pressed && (event.key.toLowerCase() === "p" || event.key === "Escape")) {
      if (GAME.state === GAME_STATE.PLAYING) {
        pauseGame();
      } else if (GAME.state === GAME_STATE.PAUSED) {
        resumeGame();
      }
    }

    if (pressed && event.code === "Space" && GAME.state !== GAME_STATE.PLAYING) {
      if (GAME.state === GAME_STATE.PAUSED) {
        resumeGame();
      } else {
        void startGame();
      }
    }
  }

  function setupTouchControls() {
    function updateTouchDirection(touches) {
      GAME.keys.left = false;
      GAME.keys.right = false;

      for (let i = 0; i < touches.length; i += 1) {
        const touch = touches[i];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const relativeX = x / rect.width;

        if (relativeX < 0.5) {
          GAME.keys.left = true;
        } else {
          GAME.keys.right = true;
        }
      }
    }

    function handleTouchStart(e) {
      e.preventDefault();
      updateTouchDirection(e.touches);
    }

    function handleTouchEnd(e) {
      e.preventDefault();
      if (e.touches.length === 0) {
        GAME.keys.left = false;
        GAME.keys.right = false;
      } else {
        updateTouchDirection(e.touches);
      }
    }

    function handleTouchMove(e) {
      e.preventDefault();
      updateTouchDirection(e.touches);
    }

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd, { passive: false });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });

    if (touchLeft) {
      touchLeft.addEventListener("touchstart", (e) => {
        e.preventDefault();
        GAME.keys.left = true;
      }, { passive: false });
      touchLeft.addEventListener("touchend", (e) => {
        e.preventDefault();
        GAME.keys.left = false;
      }, { passive: false });
    }

    if (touchRight) {
      touchRight.addEventListener("touchstart", (e) => {
        e.preventDefault();
        GAME.keys.right = true;
      }, { passive: false });
      touchRight.addEventListener("touchend", (e) => {
        e.preventDefault();
        GAME.keys.right = false;
      }, { passive: false });
    }
  }

  window.addEventListener("keydown", (event) => onKeyChange(event, true));
  window.addEventListener("keyup", (event) => onKeyChange(event, false));

  startButton.addEventListener("click", () => {
    if (GAME.state !== GAME_STATE.PLAYING) {
      void startGame();
    }
  });

  overlayStartButton.addEventListener("click", () => {
    if (GAME.state !== GAME_STATE.PLAYING) {
      void startGame();
    }
  });

  refreshButton.addEventListener("click", () => {
    loadLeaderboard();
  });

  resumeButton.addEventListener("click", () => {
    resumeGame();
  });

  quitButton.addEventListener("click", () => {
    void closeSession();
    hidePauseOverlay();
    resetGame();
  });

  playAgainButton.addEventListener("click", () => {
    void startGame();
  });

  submitScoreButton.addEventListener("click", () => {
    openScoreSubmitDialog();
  });

  pauseButton.addEventListener("click", () => {
    if (GAME.state === GAME_STATE.PLAYING) {
      pauseGame();
    } else if (GAME.state === GAME_STATE.PAUSED) {
      resumeGame();
    }
  });

  skillDashButton.addEventListener("click", () => {
    useDash();
  });

  skillClearButton.addEventListener("click", () => {
    useClearBombs();
  });

  skillUpgradeButton.addEventListener("click", () => {
    if (GAME.state === GAME_STATE.PLAYING) {
      showUpgradeDialog();
    }
  });

  upgradeOptions.addEventListener("click", (e) => {
    const option = e.target.closest('[data-skill]');
    if (option && !option.disabled) {
      const skillKey = option.dataset.skill;
      if (upgradeSkill(skillKey)) {
        showUpgradeDialog();
      }
    }
  });

  closeUpgradeButton.addEventListener("click", () => {
    if (typeof upgradeDialog.close === "function") {
      upgradeDialog.close();
    }
  });

  scoreForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await submitScore(playerNameInput.value || "Guest Cat", GAME.score);
    } catch (error) {
      console.error(error);
    } finally {
      scoreDialog.close();
    }
  });

  skipSubmitButton.addEventListener("click", () => {
    GAME.submittedScore = true;
    void closeSession();
    scoreDialog.close();
  });

  scoreDialog.addEventListener("close", () => {
    playerNameInput.blur();
  });

  GAME.backgroundData = createBackgroundData();
  resetGame();
  render();
  setupTouchControls();
  loadConfig();
  loadLeaderboard();
})();