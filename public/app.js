const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const scoreValue = document.getElementById("score-value");
const livesValue = document.getElementById("lives-value");
const timeValue = document.getElementById("time-value");
const statusValue = document.getElementById("status-value");
const overlay = document.getElementById("canvas-overlay");
const overlayText = document.getElementById("overlay-text");
const startButton = document.getElementById("start-button");
const refreshButton = document.getElementById("refresh-button");
const leaderboardList = document.getElementById("leaderboard-list");
const scoreDialog = document.getElementById("score-dialog");
const scoreForm = document.getElementById("score-form");
const playerNameInput = document.getElementById("player-name");
const finalScoreText = document.getElementById("final-score-text");
const skipSubmitButton = document.getElementById("skip-submit");

const GAME = {
  width: canvas.width,
  height: canvas.height,
  duration: 45,
  maxLives: 3,
  spawnMs: 700,
  lastTime: 0,
  animationId: 0,
  running: false,
  submittedScore: false,
  keys: {
    left: false,
    right: false
  },
  player: null,
  items: [],
  clouds: [],
  stars: [],
  score: 0,
  lives: 3,
  timeLeft: 45,
  elapsedAccumulator: 0,
  spawnAccumulator: 0
};

function createPlayer() {
  return {
    x: GAME.width / 2,
    y: GAME.height - 90,
    width: 88,
    height: 56,
    speed: 420
  };
}

function createBackground() {
  GAME.clouds = Array.from({ length: 5 }, (_, index) => ({
    x: 120 + index * 170,
    y: 80 + (index % 3) * 50,
    width: 90 + Math.random() * 60,
    speed: 10 + Math.random() * 16
  }));

  GAME.stars = Array.from({ length: 28 }, () => ({
    x: Math.random() * GAME.width,
    y: Math.random() * 180,
    radius: Math.random() * 2 + 1
  }));
}

function resetGame() {
  GAME.player = createPlayer();
  GAME.items = [];
  GAME.score = 0;
  GAME.lives = GAME.maxLives;
  GAME.timeLeft = GAME.duration;
  GAME.elapsedAccumulator = 0;
  GAME.spawnAccumulator = 0;
  GAME.lastTime = 0;
  GAME.submittedScore = false;
  updateHud();
  setStatus("等待开始");
}

function startGame() {
  resetGame();
  GAME.running = true;
  overlay.classList.add("hidden");
  setStatus("游戏中");
  GAME.animationId = requestAnimationFrame(loop);
}

function endGame() {
  GAME.running = false;
  cancelAnimationFrame(GAME.animationId);
  setStatus("已结束");
  overlay.classList.remove("hidden");
  overlayText.textContent = "按空格或点击开始再来一局。分数可以提交到后端排行榜。";
  finalScoreText.textContent = `你的得分：${GAME.score}`;

  if (typeof scoreDialog.showModal === "function" && !GAME.submittedScore) {
    playerNameInput.value = "";
    scoreDialog.showModal();
  }
}

function setStatus(text) {
  statusValue.textContent = text;
}

function updateHud() {
  scoreValue.textContent = String(GAME.score);
  livesValue.textContent = String(GAME.lives);
  timeValue.textContent = `${GAME.timeLeft}s`;
}

function spawnItem() {
  const roll = Math.random();
  let type = "fish";

  if (roll > 0.86) {
    type = "bomb";
  } else if (roll > 0.68) {
    type = "golden";
  }

  GAME.items.push({
    type,
    x: 50 + Math.random() * (GAME.width - 100),
    y: -30,
    radius: type === "bomb" ? 18 : 16,
    speed: 180 + Math.random() * 110 + (type === "bomb" ? 40 : 0),
    drift: (Math.random() - 0.5) * 24,
    wobble: Math.random() * Math.PI * 2
  });
}

function update(deltaSeconds) {
  const player = GAME.player;

  if (GAME.keys.left) {
    player.x -= player.speed * deltaSeconds;
  }
  if (GAME.keys.right) {
    player.x += player.speed * deltaSeconds;
  }

  player.x = Math.max(player.width / 2, Math.min(GAME.width - player.width / 2, player.x));

  GAME.spawnAccumulator += deltaSeconds * 1000;
  if (GAME.spawnAccumulator >= GAME.spawnMs) {
    GAME.spawnAccumulator = 0;
    spawnItem();
  }

  GAME.elapsedAccumulator += deltaSeconds;
  if (GAME.elapsedAccumulator >= 1) {
    GAME.elapsedAccumulator = 0;
    GAME.timeLeft -= 1;
    if (GAME.timeLeft <= 0) {
      GAME.timeLeft = 0;
      updateHud();
      endGame();
      return;
    }
  }

  GAME.clouds.forEach((cloud) => {
    cloud.x -= cloud.speed * deltaSeconds;
    if (cloud.x < -cloud.width) {
      cloud.x = GAME.width + cloud.width;
      cloud.y = 50 + Math.random() * 120;
    }
  });

  const playerBox = {
    left: player.x - player.width / 2,
    right: player.x + player.width / 2,
    top: player.y - player.height / 2,
    bottom: player.y + player.height / 2
  };

  GAME.items = GAME.items.filter((item) => {
    item.y += item.speed * deltaSeconds;
    item.x += Math.sin(item.wobble + item.y * 0.03) * item.drift * deltaSeconds;

    const caught =
      item.x + item.radius > playerBox.left &&
      item.x - item.radius < playerBox.right &&
      item.y + item.radius > playerBox.top &&
      item.y - item.radius < playerBox.bottom;

    if (caught) {
      if (item.type === "bomb") {
        GAME.lives -= 1;
      } else if (item.type === "golden") {
        GAME.score += 25;
      } else {
        GAME.score += 10;
      }

      updateHud();

      if (GAME.lives <= 0) {
        GAME.lives = 0;
        updateHud();
        endGame();
      }

      return false;
    }

    if (item.y - item.radius > GAME.height) {
      if (item.type !== "bomb") {
        GAME.lives -= 1;
        updateHud();
        if (GAME.lives <= 0) {
          GAME.lives = 0;
          updateHud();
          endGame();
        }
      }

      return false;
    }

    return true;
  });

  updateHud();
}

function drawSkyline() {
  ctx.fillStyle = "#15263e";
  ctx.fillRect(0, 420, GAME.width, 120);

  for (let i = 0; i < 14; i += 1) {
    const width = 42 + (i % 3) * 20;
    const height = 80 + (i % 5) * 22;
    const x = i * 66;
    const y = 420 - height;
    ctx.fillStyle = i % 2 === 0 ? "#1d3152" : "#223b61";
    ctx.fillRect(x, y, width, height);

    for (let wy = y + 10; wy < y + height - 10; wy += 18) {
      for (let wx = x + 8; wx < x + width - 8; wx += 16) {
        ctx.fillStyle = Math.random() > 0.72 ? "#ffd166" : "rgba(255, 209, 102, 0.18)";
        ctx.fillRect(wx, wy, 7, 9);
      }
    }
  }
}

function drawBackground() {
  ctx.clearRect(0, 0, GAME.width, GAME.height);

  const gradient = ctx.createLinearGradient(0, 0, 0, GAME.height);
  gradient.addColorStop(0, "#243d69");
  gradient.addColorStop(0.55, "#395f96");
  gradient.addColorStop(1, "#f08d57");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GAME.width, GAME.height);

  ctx.fillStyle = "#ffe6a7";
  ctx.beginPath();
  ctx.arc(120, 100, 44, 0, Math.PI * 2);
  ctx.fill();

  GAME.stars.forEach((star) => {
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  });

  GAME.clouds.forEach((cloud) => {
    ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
    ctx.beginPath();
    ctx.ellipse(cloud.x, cloud.y, cloud.width * 0.4, 22, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x + 36, cloud.y + 10, cloud.width * 0.32, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x - 34, cloud.y + 6, cloud.width * 0.28, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  drawSkyline();

  ctx.fillStyle = "#2b201c";
  ctx.fillRect(0, GAME.height - 60, GAME.width, 60);
  ctx.fillStyle = "#3c2d26";
  ctx.fillRect(0, GAME.height - 68, GAME.width, 8);
}

function drawCat(player) {
  ctx.save();
  ctx.translate(player.x, player.y);

  ctx.fillStyle = "#1b1b1b";
  ctx.beginPath();
  ctx.ellipse(0, 0, player.width / 2, player.height / 2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-24, -18);
  ctx.lineTo(-8, -40);
  ctx.lineTo(0, -16);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(24, -18);
  ctx.lineTo(8, -40);
  ctx.lineTo(0, -16);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#fff4da";
  ctx.beginPath();
  ctx.ellipse(0, 8, 24, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(-14, -6, 5, 0, Math.PI * 2);
  ctx.arc(14, -6, 5, 0, Math.PI * 2);
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

  ctx.fillStyle = "#f08d57";
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.lineTo(-5, 10);
  ctx.lineTo(5, 10);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawFish(item, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(item.x, item.y, 18, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(item.x + 14, item.y);
  ctx.lineTo(item.x + 28, item.y - 10);
  ctx.lineTo(item.x + 28, item.y + 10);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#11203b";
  ctx.beginPath();
  ctx.arc(item.x - 8, item.y - 2, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawBomb(item) {
  ctx.fillStyle = "#1c1c24";
  ctx.beginPath();
  ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#ff5f5f";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(item.x, item.y - 18);
  ctx.lineTo(item.x + 10, item.y - 28);
  ctx.stroke();

  ctx.fillStyle = "#ffb703";
  ctx.beginPath();
  ctx.arc(item.x + 12, item.y - 30, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawItems() {
  GAME.items.forEach((item) => {
    if (item.type === "bomb") {
      drawBomb(item);
      return;
    }

    if (item.type === "golden") {
      drawFish(item, "#ffd166");
      return;
    }

    drawFish(item, "#7ae7c7");
  });
}

function drawGroundDetails() {
  ctx.fillStyle = "rgba(255, 244, 218, 0.18)";
  for (let i = 0; i < 9; i += 1) {
    ctx.fillRect(18 + i * 100, GAME.height - 58, 64, 4);
  }
}

function render() {
  drawBackground();
  drawGroundDetails();
  drawItems();
  drawCat(GAME.player);
}

function loop(timestamp) {
  if (!GAME.running) {
    render();
    return;
  }

  if (!GAME.lastTime) {
    GAME.lastTime = timestamp;
  }

  const deltaSeconds = Math.min((timestamp - GAME.lastTime) / 1000, 0.04);
  GAME.lastTime = timestamp;

  update(deltaSeconds);
  render();

  if (GAME.running) {
    GAME.animationId = requestAnimationFrame(loop);
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
    GAME.duration = data.durationSeconds ?? GAME.duration;
    GAME.maxLives = data.maxLives ?? GAME.maxLives;
    resetGame();
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
      leaderboardList.innerHTML = "<li>还没有记录，去拿第一名。</li>";
      return;
    }

    leaderboardList.innerHTML = entries
      .map(
        (entry) => `
          <li>
            <div class="leaderboard-rank">#${entry.rank}</div>
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
    body: JSON.stringify({ name, score })
  });

  if (!response.ok) {
    throw new Error("Score submission failed");
  }

  GAME.submittedScore = true;
  await loadLeaderboard();
}

function onKeyChange(event, pressed) {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") {
    GAME.keys.left = pressed;
  }

  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") {
    GAME.keys.right = pressed;
  }

  if (pressed && event.code === "Space" && !GAME.running) {
    startGame();
  }
}

window.addEventListener("keydown", (event) => onKeyChange(event, true));
window.addEventListener("keyup", (event) => onKeyChange(event, false));

startButton.addEventListener("click", () => {
  if (!GAME.running) {
    startGame();
  }
});

refreshButton.addEventListener("click", () => {
  loadLeaderboard();
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
  scoreDialog.close();
});

scoreDialog.addEventListener("close", () => {
  playerNameInput.blur();
});

createBackground();
resetGame();
render();
loadConfig();
loadLeaderboard();
