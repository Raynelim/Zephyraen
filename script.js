import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { get, onValue, ref, set } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-database.js";
import { auth, database } from "./firebase.js?v=20260302r";

const activities = ["Village", "Stats", "Settings"];
const levelCap = 20;
const statPointsPerLevel = 5;
const baseStatValue = 10;
const realMsPerGameDay = 300_000;
const inGameMinutesPerDay = 24 * 60;

const coreStats = [
  {
    key: "strength",
    short: "STR",
    label: "Strength",
    effect: "Attack damage, carry weight",
  },
  {
    key: "agility",
    short: "AGI",
    label: "Agility",
    effect: "Turn order, dodge, stealth",
  },
  {
    key: "vitality",
    short: "VIT",
    label: "Vitality",
    effect: "Max HP, damage resistance",
  },
  {
    key: "intelligence",
    short: "INT",
    label: "Intelligence",
    effect: "Skill power, clue discovery",
  },
  {
    key: "endurance",
    short: "END",
    label: "Endurance",
    effect: "Stamina pool, exploration range",
  },
  {
    key: "perception",
    short: "PER",
    label: "Perception",
    effect: "Enemy detection, clue chance",
  },
];

function getDefaultCoreStats() {
  return {
    strength: baseStatValue,
    agility: baseStatValue,
    vitality: baseStatValue,
    intelligence: baseStatValue,
    endurance: baseStatValue,
    perception: baseStatValue,
  };
}

function getDefaultGameDetailsPayload() {
  return {
    day: 1,
    stats: {
      Level: 1,
      EXP: 0,
      "stat points available": 0,
      str: baseStatValue,
      agi: baseStatValue,
      vit: baseStatValue,
      int: baseStatValue,
      end: baseStatValue,
      per: baseStatValue,
    },
  };
}

function xpForLevel(level) {
  if (level >= levelCap) {
    return 0;
  }

  return 100 + (level - 1) * 50;
}

function parseStatValue(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(baseStatValue, Math.round(numericValue));
}

function processLevelUps(initialLevel, initialXp) {
  let currentLevel = Math.max(1, Math.round(Number(initialLevel) || 1));
  let currentXp = Math.max(0, Math.round(Number(initialXp) || 0));
  let leveledUp = false;

  while (currentLevel < levelCap) {
    const requiredXp = xpForLevel(currentLevel);
    if (currentXp < requiredXp) {
      break;
    }

    currentXp -= requiredXp;
    currentLevel += 1;
    leveledUp = true;
  }

  if (currentLevel >= levelCap) {
    currentXp = 0;
  }

  return {
    level: currentLevel,
    xp: currentXp,
    leveledUp,
  };
}

function isPayloadEquivalent(rawValue, payload) {
  if (!rawValue || typeof rawValue !== "object") {
    return false;
  }

  return JSON.stringify(rawValue) === JSON.stringify(payload);
}

function normalizeGameDetailsPayload(rawGameDetails) {
  const defaults = getDefaultGameDetailsPayload();
  const incoming = rawGameDetails && typeof rawGameDetails === "object" ? rawGameDetails : {};
  const incomingStats = incoming.stats && typeof incoming.stats === "object" ? incoming.stats : incoming;

  const rawLevel = Number(incomingStats.Level ?? incomingStats.playerLevel ?? incoming.level ?? defaults.stats.Level);
  const rawXp = Number(incomingStats.EXP ?? incomingStats.xp ?? defaults.stats.EXP);
  const resolvedProgression = processLevelUps(rawLevel, rawXp);

  const normalizedStats = {
    Level: resolvedProgression.level,
    EXP: resolvedProgression.xp,
    str: parseStatValue(incomingStats.str ?? incomingStats.strength, defaults.stats.str),
    agi: parseStatValue(incomingStats.agi ?? incomingStats.agility, defaults.stats.agi),
    vit: parseStatValue(incomingStats.vit ?? incomingStats.vitality, defaults.stats.vit),
    int: parseStatValue(incomingStats.int ?? incomingStats.intelligence, defaults.stats.int),
    end: parseStatValue(incomingStats.end ?? incomingStats.endurance, defaults.stats.end),
    per: parseStatValue(incomingStats.per ?? incomingStats.perception, defaults.stats.per),
  };

  const spentPoints =
    (normalizedStats.str - baseStatValue) +
    (normalizedStats.agi - baseStatValue) +
    (normalizedStats.vit - baseStatValue) +
    (normalizedStats.int - baseStatValue) +
    (normalizedStats.end - baseStatValue) +
    (normalizedStats.per - baseStatValue);

  const allocatablePoints = Math.max(0, (normalizedStats.Level - 1) * statPointsPerLevel);
  normalizedStats["stat points available"] = Math.max(0, allocatablePoints - spentPoints);

  const normalized = {
    day: Math.max(1, Math.round(Number(incoming.day ?? defaults.day) || defaults.day)),
    stats: normalizedStats,
  };

  return {
    payload: normalized,
    shouldSave: !isPayloadEquivalent(incoming, normalized),
    leveledUpFromOverflowXp: resolvedProgression.leveledUp,
  };
}

const state = {
  page: "Village",
  day: 1,
  level: 1,
  xp: 0,
  xpRequired: xpForLevel(1),
  statPoints: 0,
  coreStats: getDefaultCoreStats(),
  villageLevel: 1,
  log: [],
  uid: null,
  name: "Player",
  email: "",
  gameDetailsPath: "",
  clockAnchorDay: 1,
  clockAnchorRealMs: Date.now(),
  lastClockDay: 1,
  isPersistingDay: false,
};

const ui = {
  stats: document.getElementById("stats"),
  activities: document.getElementById("activities"),
  title: document.getElementById("screenTitle"),
  worldClock: document.getElementById("worldClock"),
  clockPhase: document.getElementById("clockPhase"),
  clockTime: document.getElementById("clockTime"),
  text: document.getElementById("mainText"),
  log: document.getElementById("log"),
  ascii: document.getElementById("asciiAnim"),
};

let frameTicker = null;
let statsUnsubscribe = null;
let clockTicker = null;

function getGameDetailsPayloadFromState() {
  return {
    day: state.day,
    stats: {
      Level: state.level,
      EXP: state.xp,
      "stat points available": state.statPoints,
      str: state.coreStats.strength,
      agi: state.coreStats.agility,
      vit: state.coreStats.vitality,
      int: state.coreStats.intelligence,
      end: state.coreStats.endurance,
      per: state.coreStats.perception,
    },
  };
}

function recalculateDerivedState() {
  const spentPoints = coreStats.reduce((total, stat) => total + (state.coreStats[stat.key] - baseStatValue), 0);
  const allocatablePoints = Math.max(0, (state.level - 1) * statPointsPerLevel);
  state.statPoints = Math.max(0, allocatablePoints - spentPoints);
  state.xpRequired = xpForLevel(state.level);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function setClockAnchor(day) {
  state.clockAnchorDay = Math.max(1, Math.round(Number(day) || 1));
  state.clockAnchorRealMs = Date.now();
  state.lastClockDay = state.clockAnchorDay;
}

function getWorldClockSnapshot(now = Date.now()) {
  const elapsedMs = Math.max(0, now - state.clockAnchorRealMs);
  const dayOffset = Math.floor(elapsedMs / realMsPerGameDay);
  const currentDay = state.clockAnchorDay + dayOffset;
  const dayProgress = (elapsedMs % realMsPerGameDay) / realMsPerGameDay;
  const totalMinutes = Math.floor(dayProgress * inGameMinutesPerDay);
  const snappedTotalMinutes = Math.floor(totalMinutes / 30) * 30;
  const hour = Math.floor(snappedTotalMinutes / 60) % 24;
  const minute = snappedTotalMinutes % 60;
  const isDaytime = hour >= 6 && hour < 18;

  return {
    day: currentDay,
    hour,
    minute,
    phaseLabel: isDaytime ? "DAY" : "NIGHT",
    phaseIcon: isDaytime ? "☀" : "☾",
    timeText: `${pad2(hour)}:${pad2(minute)}`,
  };
}

function renderWorldClock() {
  const snapshot = getWorldClockSnapshot();
  if (ui.clockPhase) {
    ui.clockPhase.textContent = `${snapshot.phaseIcon} ${snapshot.phaseLabel}`;
  }
  if (ui.clockTime) {
    ui.clockTime.textContent = `Day ${snapshot.day} || ${snapshot.timeText}`;
  }
  if (ui.worldClock) {
    ui.worldClock.classList.toggle("night", snapshot.phaseLabel === "NIGHT");
  }

  if (snapshot.day !== state.day) {
    state.day = snapshot.day;
  }

  return snapshot;
}

async function syncDayIfChanged(snapshot) {
  if (!snapshot || snapshot.day === state.lastClockDay || state.isPersistingDay) {
    return;
  }

  state.lastClockDay = snapshot.day;

  if (!state.gameDetailsPath) {
    return;
  }

  state.isPersistingDay = true;
  try {
    await persistStats();
    addLog(`Day advanced to ${snapshot.day}.`);
    renderLog();
  } catch (error) {
    console.error("Failed to persist day progression:", error);
    addLog("Sync warning: day progression could not be saved.");
    renderLog();
  } finally {
    state.isPersistingDay = false;
  }
}

function startWorldClock() {
  if (clockTicker) {
    clearInterval(clockTicker);
  }

  const tick = async () => {
    const snapshot = renderWorldClock();
    await syncDayIfChanged(snapshot);
  };

  void tick();
  clockTicker = setInterval(() => {
    void tick();
  }, 1000);
}

function addLog(message) {
  const snapshot = getWorldClockSnapshot();
  state.log.unshift({
    message,
    day: snapshot.day,
    time: snapshot.timeText,
    phaseIcon: snapshot.phaseIcon,
    phaseLabel: snapshot.phaseLabel,
  });
  state.log = state.log.slice(0, 30);
}

async function persistStats() {
  if (!state.gameDetailsPath) {
    return;
  }

  const gameDetailsRef = ref(database, state.gameDetailsPath);
  await set(gameDetailsRef, getGameDetailsPayloadFromState());
}

function renderStats() {
  const summaryStats = [
    ["Level", state.level],
    ["Stat Points", state.statPoints],
    ["Village Level", state.villageLevel],
  ];

  const xpLabel = state.xpRequired > 0 ? `${state.xp}/${state.xpRequired}` : "MAX";
  const xpPercent = state.xpRequired > 0 ? Math.min(100, Math.round((state.xp / state.xpRequired) * 100)) : 100;

  const coreRows = coreStats
    .map(
      (stat) =>
        `<li><span><strong class="stat-short">${stat.short}</strong> ${stat.label}</span><strong>${state.coreStats[stat.key]}</strong></li>`
    )
    .join("");

  ui.stats.innerHTML = summaryStats
    .map(([name, value]) => `<li><span>${name}</span><strong>${value}</strong></li>`)
    .join("")
    .concat(
      `<li class="xp-row"><div class="xp-head"><span>EXP ${xpLabel}</span></div><div class="xp-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${xpPercent}"><span class="xp-fill" style="width: ${xpPercent}%"></span></div></li>${coreRows}`
    );
}

function renderActivities() {
  ui.activities.innerHTML = activities
    .map(
      (activity) =>
        `<button class="activity-btn ${state.page === activity ? "active" : ""}" data-activity="${activity}">${activity}</button>`
    )
    .join("");

  ui.activities.querySelectorAll(".activity-btn").forEach((button) => {
    button.addEventListener("click", () => {
      state.page = button.dataset.activity;
      render();
    });
  });
}

function renderLog() {
  ui.log.innerHTML = state.log
    .map((entry) => {
      const normalized =
        typeof entry === "string"
          ? { message: entry, day: state.day, time: "--:--", phaseIcon: "●", phaseLabel: "LOG" }
          : entry;

      return `<li><div class="log-meta"><span class="log-phase">${normalized.phaseIcon} ${normalized.phaseLabel}</span><span class="log-stamp">D${normalized.day} // ${normalized.time}</span></div><p class="log-message">${normalized.message}</p></li>`;
    })
    .join("");
}

function animateAscii() {
  if (frameTicker) {
    clearInterval(frameTicker);
    frameTicker = null;
  }

  ui.ascii.textContent = "";
}

function renderVillage() {
  ui.text.innerHTML = "Village systems online.";
}

async function assignStatPoint(statKey) {
  if (state.statPoints <= 0) {
    addLog("No available stat points.");
    render();
    return;
  }

  if (!(statKey in state.coreStats)) {
    return;
  }

  state.coreStats[statKey] += 1;
  recalculateDerivedState();
  addLog(`+1 assigned to ${statKey.toUpperCase()}.`);

  try {
    await persistStats();
  } catch (error) {
    console.error("Failed to persist stat assignment:", error);
    addLog("Sync warning: stat allocation could not be saved.");
  }

  render();
}

function renderStatsPage() {
  const statRows = coreStats
    .map(
      (stat) =>
        `<div class="stat-row"><div class="stat-info"><p><strong>${stat.short} ${stat.label}</strong></p><p class="inline-tag">${stat.effect}</p></div><div class="stat-controls"><strong>${state.coreStats[stat.key]}</strong><button class="action-btn" data-stat-plus="${stat.key}" ${state.statPoints <= 0 ? "disabled" : ""}>+1</button></div></div>`
    )
    .join("");

  const xpLine = state.xpRequired > 0 ? `${state.xp}/${state.xpRequired} XP` : "MAX";

  ui.text.innerHTML = `CHITIN-FRAME Stat Console\n\n<div class="settings-grid">\n  <div class="settings-account">\n    <p class="inline-tag">LEVEL : <strong>${state.level}</strong></p>\n    <p class="inline-tag">EXP : <strong>${xpLine}</strong></p>\n    <p class="inline-tag">AVAILABLE STAT POINTS : <strong>${state.statPoints}</strong></p>\n    <p class="inline-tag">LEVEL CAP [PART I] : 20 // +5 POINTS PER LEVEL</p>\n  </div>\n  <div class="stats-console-grid">${statRows}</div>\n</div>`;

  ui.text.querySelectorAll("[data-stat-plus]").forEach((button) => {
    button.addEventListener("click", async () => {
      const statKey = button.dataset.statPlus;
      await assignStatPoint(statKey);
    });
  });

}

function deriveNameFromEmail(email) {
  if (!email || !email.includes("@")) {
    return "Player";
  }

  const localPart = email.split("@")[0]?.trim();
  return localPart || "Player";
}

function renderSettings() {
  const displayName = state.name || deriveNameFromEmail(state.email);
  const displayEmail = state.email || "player@unknown";
  ui.text.innerHTML = `Settings:\n\n<div class="settings-grid">\n  <div class="settings-account">\n    <p class="inline-tag">LOGGED IN AS : <strong class="settings-name">${displayName}</strong></p>\n    <p class="settings-email">${displayEmail}</p>\n  </div>\n  <button class="option-btn" data-setting="tutorial">Tutorial Guide</button>\n  <button class="option-btn" data-setting="logout">Log out</button>\n</div>`;

  ui.text.querySelectorAll(".option-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const type = button.dataset.setting;

      if (type === "rules") {
        addLog("Gameplay Rules selected.");
      }

      if (type === "tutorial") {
        window.location.href = "tutorial.html";
        return;
      }

      if (type === "logout") {
        await signOut(auth);
        window.location.href = "index.html";
        return;
      }

      render();
    });
  });
}

function render() {
  ui.title.textContent = state.page;
  renderWorldClock();

  renderStats();
  renderActivities();

  if (state.page === "Village") {
    renderVillage();
  } else if (state.page === "Stats") {
    renderStatsPage();
  } else {
    renderSettings();
  }

  renderLog();
  animateAscii();
}

function subscribeToUserStats(uid) {
  if (statsUnsubscribe) {
    statsUnsubscribe();
    statsUnsubscribe = null;
  }

  const accountDetailsRef = ref(database, `players/${uid}/account details`);
  const legacyAccountDetailsRef = ref(database, `players/${uid}/accountDetails`);

  get(accountDetailsRef).then(async (accountSnapshot) => {
    const resolvedSnapshot = accountSnapshot.exists() ? accountSnapshot : await get(legacyAccountDetailsRef);
    const accountDetails = resolvedSnapshot.exists() ? resolvedSnapshot.val() ?? {} : {};
    const accountEmail = typeof accountDetails?.email === "string" ? accountDetails.email.trim() : "";
    const accountName = typeof accountDetails?.username === "string" ? accountDetails.username.trim() : "";
    if (accountEmail) {
      state.email = accountEmail;
    }
    state.name = accountName || deriveNameFromEmail(state.email);

    const difficultyLevel = accountDetails?.DifficultyLevel ?? accountDetails?.difficultyLevel ?? {};
    const preferredOrder = ["easy", "normal", "hardcore"];
    const firstValid = preferredOrder.find((level) => Boolean(difficultyLevel?.[level]?.gameDetails));
    const normalizedDifficulty = firstValid || "normal";

    const gameDetailsRef = ref(database, `players/${uid}/account details/DifficultyLevel/${normalizedDifficulty}/gameDetails`);
    state.gameDetailsPath = `players/${uid}/account details/DifficultyLevel/${normalizedDifficulty}/gameDetails`;

    statsUnsubscribe = onValue(gameDetailsRef, async (snapshot) => {
      if (!snapshot.exists()) {
        await set(gameDetailsRef, getDefaultGameDetailsPayload());
        return;
      }

      const rawGameDetails = snapshot.val();
      const { payload, shouldSave, leveledUpFromOverflowXp } = normalizeGameDetailsPayload(rawGameDetails);

      state.day = payload.day;
      state.level = payload.stats.Level;
      state.xp = payload.stats.EXP;
      state.statPoints = payload.stats["stat points available"];
      state.coreStats = {
        strength: payload.stats.str,
        agility: payload.stats.agi,
        vitality: payload.stats.vit,
        intelligence: payload.stats.int,
        endurance: payload.stats.end,
        perception: payload.stats.per,
      };
      recalculateDerivedState();
      setClockAnchor(state.day);

      if (leveledUpFromOverflowXp) {
        addLog("Overflow EXP converted into level progression.");
      }

      if (shouldSave) {
        try {
          await set(gameDetailsRef, payload);
        } catch (error) {
          console.error("Failed to normalize player stats:", error);
          addLog("Sync warning: normalized stats could not be saved.");
        }
      }

      render();
    });
  });
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  state.uid = user.uid;
  state.email = user.email ?? "";
  state.name = deriveNameFromEmail(state.email);
  setClockAnchor(state.day);
  startWorldClock();
  addLog(`Signed in as ${user.email ?? "player"}.`);
  subscribeToUserStats(user.uid);
  render();
});
