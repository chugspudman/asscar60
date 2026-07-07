import { conditionForRoll, courseByName, courseSummary } from "./courses.mjs";

export const TOTAL_LAPS = 60;

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomGenerator(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function pronounForms(driver) {
  const forms = {
    "She/Her": {
      subject: "she", object: "her", possessive: "her", reflexive: "herself", pluralVerb: false,
    },
    "He/Him": {
      subject: "he", object: "him", possessive: "his", reflexive: "himself", pluralVerb: false,
    },
    "They/Them": {
      subject: "they", object: "them", possessive: "their", reflexive: "themselves", pluralVerb: true,
    },
    "It/It": {
      subject: "it", object: "it", possessive: "its", reflexive: "itself", pluralVerb: false,
    },
  }[driver?.pronouns] || {
    subject: "they", object: "them", possessive: "their", reflexive: "themselves", pluralVerb: true,
  };
  return {
    ...forms,
    subjectCapitalized: forms.subject[0].toUpperCase() + forms.subject.slice(1),
  };
}

export function personalizeRaceFeedMessage(message, driver) {
  if (!message || !driver?.name || !message.includes(driver.name)) return message;
  const pronouns = pronounForms(driver);
  const gun = pronouns.pluralVerb ? "gun" : "guns";
  const gather = pronouns.pluralVerb ? "gather" : "gathers";
  const recover = pronouns.pluralVerb ? "recover" : "recovers";
  const hit = pronouns.pluralVerb ? "hit" : "hits";
  return message
    .replace("as they gun over the curbs", `as ${pronouns.subject} ${gun} over the curbs`)
    .replace("but they gather it up", `but ${pronouns.subject} ${gather} it up`)
    .replace(
      "They recover, but they lost about 10 seconds",
      `${pronouns.subjectCapitalized} ${recover}, but ${pronouns.subject} lost about 10 seconds`,
    )
    .replace("before they hit them", `before ${pronouns.subject} ${hit} them`)
    .replace(
      "briefly closes their eyes and places their hand on chassis of the car, letting it tell them what to see",
      `briefly closes ${pronouns.possessive} eyes and places ${pronouns.possessive} hand on chassis of the car, letting it tell ${pronouns.object} what to see`,
    )
    .replace(
      "They are branded by The Mark of The Speed God and get SPEED MADNESS",
      `${pronouns.subjectCapitalized} is branded by The Mark of The Speed God and gets SPEED MADNESS`,
    )
    .replace(
      "in their grief, comes to a dead stop",
      `in ${pronouns.possessive} grief, comes to a dead stop`,
    );
}

const STRANGE_EFFECT_SUMMARIES = [
  ["tires are glowing blue!", "Handling +1 this race"],
  ["chassis is becoming all chrome?!", "Durability +1 this race"],
  ["exhaust is spitting purple flames!", "Speed +1 this race"],
  ["religious speedpiphany!", "Pace +1 this race"],
  ["has a premonition, and sees the turns", "Control +1 this race"],
  ["brief blood rage and gets aggressive!", "Overtaking +1 this race"],
  ["a white, holy aura and seems reinvigorated.", "Stamina +1 this race"],
  ["places", "Technical +1 this race"],
  ["muck of The Decelerator cakes", "Handling -1 this race"],
  ["rust of ages ripples across", "Durability -1 this race"],
  ["infused with heretical geometries!", "Speed -1 this race"],
  ["tempted by the mutterings of The Decelerator!", "Pace -1 this race"],
  ["becomes drunk with speed!", "Control -1 this race"],
  ["becomes meek under the gaze of The Stewards", "Overtaking -1 this race"],
  ["forgets the blessings of speed and perpetuality!", "Stamina -1 this race"],
  ["questions the teachings of The Stewards", "Technical -1 this race"],
  ["favored by Velocitus and given a burst of speed!", "Jump 1 ahead in position"],
  ["grace", "Reset DRIVER and CAR degradation"],
  [
    "gets SPEED MADNESS!",
    "Pace +1, Control -2, turns more severe; Given The Mark of The Speed God permanently",
  ],
  ["comes to a dead stop.", "Driver DNFs; No points"],
];

export function appendStrangeEffectSummary(message) {
  if (!message || /\([^()]+\)$/.test(message)) return message;
  const match = STRANGE_EFFECT_SUMMARIES.find(([fragment]) => message.includes(fragment));
  return match ? `${message} (${match[1]})` : message;
}

function driverFromStanding(standing) {
  return {
    name: standing.driver,
    pronouns: standing.driverPronouns,
  };
}

function driverForLap(entry, lap) {
  return entry.stints.find((stint) => lap >= stint.start && lap <= stint.end)?.driver
    || entry.stints.at(-1).driver;
}

function rankEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.status === "dnf" || b.status === "dnf") {
      if (a.status !== b.status) return a.status === "dnf" ? 1 : -1;
      return b.completedLaps - a.completedLaps || a.elapsed - b.elapsed;
    }
    if (a.completedLaps !== b.completedLaps) return b.completedLaps - a.completedLaps;
    if (a.finishTime !== null || b.finishTime !== null) {
      return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity);
    }
    return a.elapsed - b.elapsed
      || (a.startingGridPosition ?? Number.MAX_SAFE_INTEGER)
        - (b.startingGridPosition ?? Number.MAX_SAFE_INTEGER);
  });
}

function snapshot(entries, timestamp) {
  const ranked = rankEntries(entries);
  const leader = ranked[0];
  return ranked.map((entry, index) => ({
    id: entry.id,
    position: index + 1,
    completedLaps: entry.completedLaps,
    elapsed: entry.elapsed,
    lastLapTime: entry.lastLapTime,
    gap: index === 0
      ? 0
      : Math.max(0, entry.elapsed - leader.elapsed)
        + Math.max(0, leader.completedLaps - entry.completedLaps) * 50,
    driver: driverForLap(entry, Math.min(TOTAL_LAPS, entry.completedLaps + 1)).name,
    driverPronouns: driverForLap(
      entry,
      Math.min(TOTAL_LAPS, entry.completedLaps + 1),
    ).pronouns,
    status: entry.status,
    timestamp,
  }));
}

function snapshotAtTime(entries, timestamp) {
  const states = entries.map((entry) => {
    const completed = entry.lapRecords.filter((record) => record.end <= timestamp);
    const active = entry.lapRecords.find(
      (record) => record.start <= timestamp && record.end > timestamp,
    );
    const completedLaps = completed.length;
    const isDnf = entry.dnfTime !== null && entry.dnfTime <= timestamp;
    const progress = active
      ? clamp((timestamp - active.start) / (active.end - active.start), 0, 0.999999)
      : completedLaps >= TOTAL_LAPS ? 0 : 0;
    const latest = completed.at(-1);
    return {
      entry,
      completedLaps,
      progress,
      raceProgress: completedLaps + (isDnf ? entry.dnfProgress : progress),
      lastLapTime: latest ? latest.end - latest.start : null,
      driver: isDnf
        ? entry.dnfDriver
        : active?.driver || latest?.driver || driverForLap(entry, 1),
      status: isDnf ? "dnf" : completedLaps >= TOTAL_LAPS ? "finished" : "running",
      finishTime: completedLaps >= TOTAL_LAPS ? latest.end : null,
    };
  });
  states.sort((a, b) => (
    (a.status === "dnf") - (b.status === "dnf")
    || b.raceProgress - a.raceProgress
    || (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity)
    || a.entry.id.localeCompare(b.entry.id)
  ));
  const leader = states[0];
  return states.map((state, index) => ({
    id: state.entry.id,
    position: index + 1,
    completedLaps: state.completedLaps,
    elapsed: timestamp,
    lastLapTime: state.lastLapTime,
    gap: index === 0 ? 0 : Math.max(0, leader.raceProgress - state.raceProgress) * 50,
    driver: state.driver.name,
    driverPronouns: state.driver.pronouns,
    status: state.status,
    timestamp,
  }));
}

function applyEventPosition(standings, event) {
  if (
    !event.relatedEntryId
    || (event.type !== "overtake" && !event.positionJump)
  ) return standings;
  const attackerIndex = standings.findIndex((standing) => standing.id === event.entryId);
  const defenderIndex = standings.findIndex(
    (standing) => standing.id === event.relatedEntryId,
  );
  if (attackerIndex < 0 || defenderIndex < 0 || attackerIndex < defenderIndex) {
    return standings;
  }
  const adjusted = [...standings];
  const [attacker] = adjusted.splice(attackerIndex, 1);
  const newDefenderIndex = adjusted.findIndex(
    (standing) => standing.id === event.relatedEntryId,
  );
  adjusted.splice(newDefenderIndex, 0, attacker);
  return adjusted.map((standing, index) => ({
    ...standing,
    position: index + 1,
  }));
}

function linearScale(rating, low, high) {
  return low + ((clamp(rating, 1, 10) - 1) / 9) * (high - low);
}

function degradationOverForty(endurance) {
  return linearScale(endurance, 3, 1);
}

function mitigation(rating) {
  return linearScale(rating, 0.10, 0.75);
}

function weirdChance(rating) {
  return linearScale(rating, 1 / 300, 1 / 20);
}

function attackerWinsOvertake(attackerOvertaking, defenderOvertaking, random) {
  const attack = clamp(attackerOvertaking, 1, 10);
  const defense = clamp(defenderOvertaking, 1, 10);
  const totalTenths = Math.max(1, Math.round((attack + defense) * 10));
  const roll = (Math.floor(random() * totalTenths) + 1) / 10;
  return roll <= attack;
}

function weatherMishapFactor(condition) {
  if (condition === "Raining") return 0.9;
  if (condition === "Snowing") return 0.7;
  return 1;
}

function actionMessage(standings, entriesById, random) {
  const focusIndex = Math.floor(random() * Math.min(8, standings.length));
  const focus = standings[focusIndex];
  const entry = entriesById.get(focus.id);
  const ahead = focusIndex > 0 ? standings[focusIndex - 1] : standings[1];
  const aheadEntry = entriesById.get(ahead.id);
  const driver = driverFromStanding(focus);
  const pronouns = pronounForms(driver);
  const gun = pronouns.pluralVerb ? "gun" : "guns";
  const gather = pronouns.pluralVerb ? "gather" : "gathers";
  const lap = Math.max(1, focus.completedLaps + 1);
  const messages = [
    `${driver.name} keeps the throttle open as ${pronouns.subject} ${gun} over the curbs.`,
    `${entry.carName}'s brakes being ridden hard as ${driver.name} enters the turn.`,
    `${driver.name} is filling ${aheadEntry.carName}'s mirrors on lap ${lap}.`,
    `${driver.name} pumps the brakes and ${entry.carName} snaps sideways, but ${pronouns.subject} ${gather} it up.`,
    `${driver.name} threads ${entry.carName} through a narrow lane of traffic.`,
    `${entry.carName} attacks the next sector hard.`,
    `${driver.name} takes a piercing line through the chicane.`,
    `${driver.name} takes a striking line through the chicane.`,
    `${driver.name} takes a tight line through the chicane.`,
    `${driver.name} takes a loose line through the chicane.`,
    `${entry.carName} closes through the straight, engine note climbing.`,
    `${driver.name} skims the outer wall but keeps the throttle pinned.`,
  ];
  return messages[Math.floor(random() * messages.length)];
}

function addActionEvents(events, entries, duration, random) {
  const chronological = [...events].sort((a, b) => a.time - b.time);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let eventIndex = 0;
  let latestStandings = chronological[0].standings;
  let actionTime = 20 + random() * 20;

  while (actionTime < duration) {
    while (
      eventIndex + 1 < chronological.length
      && chronological[eventIndex + 1].time <= actionTime
    ) {
      eventIndex += 1;
      latestStandings = chronological[eventIndex].standings;
    }
    events.push({
      time: actionTime,
      type: "action",
      message: actionMessage(latestStandings, entriesById, random),
      standings: latestStandings.map((standing) => ({ ...standing, timestamp: actionTime })),
    });
    actionTime += 20 + random() * 20;
  }
}

const ALWAYS_PUBLISH_EVENT_TYPES = new Set([
  "qualifier",
  "martyr-ceremony",
  "race-start",
  "strange",
  "spin",
  "lap",
  "winner",
  "finish",
  "podium",
]);

function shouldAlwaysPublish(event) {
  return ALWAYS_PUBLISH_EVENT_TYPES.has(event.type);
}

function throttleFeedEvents(events, minimumSpacing = 2) {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  let lastPublishedTime = -Infinity;
  return sorted.filter((event) => {
    if (!event.message) return true;
    if (shouldAlwaysPublish(event)) {
      lastPublishedTime = Math.max(lastPublishedTime, event.time);
      return true;
    }
    if (event.time - lastPublishedTime < minimumSpacing) return false;
    lastPublishedTime = event.time;
    return true;
  });
}

function addMishap(candidate, target, random, reason, progress, penalty = 3) {
  candidate.lapDuration += penalty;
  candidate.mishaps += 1;
  candidate.messages.push({
    type: "incident",
    message: reason,
    progress,
  });
  if (random() < 1 / 800) {
    const pronouns = pronounForms(target);
    const recover = pronouns.pluralVerb ? "recover" : "recovers";
    candidate.lapDuration += 10;
    candidate.messages.push({
      type: "spin",
      message: `${target.name} spins out! ${pronouns.subjectCapitalized} ${recover}, but ${pronouns.subject} lost about 10 seconds...`,
      progress: Math.min(0.98, progress + 0.01),
    });
  }
}

function cornerMishapPenalty(severity, random) {
  return severity <= 3
    ? 2 + Math.floor(random() * 2)
    : 3 + Math.floor(random() * 2);
}

const ALWAYS_STRANGE_EFFECTS = [
  { tone: "good", target: "car", stat: "handling", delta: 1, message: (car) => `${car}'s tires are glowing blue!` },
  { tone: "good", target: "car", stat: "durability", delta: 1, message: (car) => `${car}'s chassis is becoming all chrome?!` },
  { tone: "good", target: "car", stat: "speed", delta: 1, message: (car) => `${car}'s exhaust is spitting purple flames!` },
  { tone: "good", target: "driver", stat: "pace", delta: 1, message: (_, driver) => `${driver.name} hears the voice of The Speed God and has a religious speedpiphany!` },
  { tone: "good", target: "driver", stat: "control", delta: 1, message: (_, driver) => {
    const pronouns = pronounForms(driver);
    return `${driver.name} has a premonition, and sees the turns before ${pronouns.subject} ${pronouns.pluralVerb ? "hit" : "hits"} them.`;
  } },
  { tone: "good", target: "driver", stat: "overtaking", delta: 1, message: (_, driver) => `${driver.name} falls into a brief blood rage and gets aggressive!` },
  { tone: "good", target: "driver", stat: "stamina", delta: 1, message: (_, driver) => `${driver.name} begins to glow with a white, holy aura and seems reinvigorated.` },
  { tone: "good", target: "driver", stat: "technical", delta: 1, message: (_, driver) => {
    const pronouns = pronounForms(driver);
    return `${driver.name} briefly closes ${pronouns.possessive} eyes and places ${pronouns.possessive} hand on chassis of the car, letting it tell ${pronouns.object} what to see.`;
  } },
  { tone: "bad", target: "car", stat: "handling", delta: -1, message: (car) => `The muck of The Decelerator cakes ${car}'s tires!` },
  { tone: "bad", target: "car", stat: "durability", delta: -1, message: (car) => `The rust of ages ripples across ${car}'s chassis!` },
  { tone: "bad", target: "car", stat: "speed", delta: -1, message: (car) => `The engine of ${car} has been infused with heretical geometries!` },
  { tone: "bad", target: "driver", stat: "pace", delta: -1, message: (_, driver) => `${driver.name} is tempted by the mutterings of The Decelerator!` },
  { tone: "bad", target: "driver", stat: "control", delta: -1, message: (_, driver) => `${driver.name} becomes drunk with speed!` },
  { tone: "bad", target: "driver", stat: "overtaking", delta: -1, message: (_, driver) => `${driver.name} becomes meek under the gaze of The Stewards, their majesty ever-shining!` },
  { tone: "bad", target: "driver", stat: "stamina", delta: -1, message: (_, driver) => `${driver.name} forgets the blessings of speed and perpetuality!` },
  { tone: "bad", target: "driver", stat: "technical", delta: -1, message: (_, driver) => `${driver.name} questions the teachings of The Stewards, all-knowing and pure!` },
];

const CHURNING_EFFECTS = [
  { tone: "good", special: "position", message: (car) => `Behold the Churning! ${car} is favored by Velocitus and given a burst of speed!` },
  { tone: "good", special: "reset", message: (car, driver) => `Behold the Churning! The Stewards, with infinite beneficence, grace ${driver.name} and ${car} with holy acts!` },
  { tone: "bad", special: "mark", message: (_, driver) => {
    const pronouns = pronounForms(driver);
    return `The Churning is nigh! ${driver.name} is scorched by the divinity of The Speed God. ${pronouns.subjectCapitalized} is branded by The Mark of The Speed God and gets SPEED MADNESS!`;
  } },
  { tone: "bad", special: "dnf", message: (_, driver) => {
    const pronouns = pronounForms(driver);
    return `The Churning is nigh! ${driver.name} is shown The End of All Things by The Decelerator and, in ${pronouns.possessive} grief, comes to a dead stop.`;
  } },
];

function driverBonuses(entry, driverId) {
  if (!entry.driverBonuses.has(driverId)) entry.driverBonuses.set(driverId, {});
  return entry.driverBonuses.get(driverId);
}

function updateFatigue(entry, activeDriver, feedback) {
  for (const driver of entry.uniqueDrivers) {
    const current = entry.driverFatigue.get(driver.id) || 0;
    const bonuses = driverBonuses(entry, driver.id);
    const effectiveStamina = clamp(driver.stamina + (bonuses.stamina || 0), 1, 10);
    const lossPerLap = degradationOverForty(effectiveStamina)
      / 40
      * (1 - mitigation(feedback));
    entry.driverFatigue.set(
      driver.id,
      driver.id === activeDriver.id
        ? current + lossPerLap
        : Math.max(0, current - lossPerLap * 2),
    );
  }
}

function lapCandidate(entry, lap, course, condition, random) {
  const driver = driverForLap(entry, lap);
  const bonuses = driverBonuses(entry, driver.id);
  const driverFatigue = entry.driverFatigue.get(driver.id) || 0;
  const effectiveControl = clamp(driver.control + (bonuses.control || 0) - driverFatigue, 1, 10);
  const effectiveOvertaking = clamp(driver.overtaking + (bonuses.overtaking || 0) - driverFatigue, 1, 10);
  const effectiveSpeed = clamp(entry.vehicle.speed + (entry.carBonuses.speed || 0) - entry.carWear, 1, 10);
  const effectiveHandling = clamp(entry.vehicle.handling + (entry.carBonuses.handling || 0) - entry.carWear, 1, 10);
  const effectivePace = clamp(driver.pace + (bonuses.pace || 0), 1, 10);
  const paceTerm = 0.7 * effectivePace + 0.3 * effectiveSpeed;
  const candidate = {
    entry,
    driver,
    lap,
    effectiveControl,
    effectiveOvertaking,
    effectiveHandling,
    lapDuration: 40 + course.length - paceTerm,
    mishaps: 0,
    messages: [],
    severityBonus: bonuses.severity || 0,
    strangeEffect: null,
    dnf: false,
  };
  if (lap === 1 && Number.isFinite(entry.startingGridPenalty)) {
    candidate.lapDuration += entry.startingGridPenalty;
  }

  const strangeChance = Math.min(
    1,
    weirdChance(clamp((driver.weird ?? driver.strangeness) + (bonuses.weird || 0), 1, 10))
      + weirdChance(entry.vehicle.weird),
  );
  if (random() < strangeChance) {
    const effects = condition === "Churning"
      ? [...ALWAYS_STRANGE_EFFECTS, ...CHURNING_EFFECTS]
      : ALWAYS_STRANGE_EFFECTS;
    candidate.strangeEffect = {
      ...effects[Math.floor(random() * effects.length)],
      progress: 0.08 + random() * 0.84,
    };
  }

  const priorDriver = lap > 1 ? driverForLap(entry, lap - 1) : driver;
  if (lap > 1 && priorDriver.id !== driver.id) {
    candidate.lapDuration += 9 + random() * 4;
    candidate.messages.push({
      type: "driver-swap",
      message: `${entry.carName} pits and ${priorDriver.name} passes the controls to ${driver.name}.`,
      progress: 0.02,
    });
  }
  return candidate;
}

function applyStrangeEffect(candidate, order) {
  const effect = candidate.strangeEffect;
  if (!effect || effect.applied) return;
  effect.applied = true;
  const { entry, driver } = candidate;
  const message = {
    type: "strange",
    message: appendStrangeEffectSummary(effect.message(entry.carName, driver)),
    progress: effect.progress,
    tone: effect.tone,
    racerId: driver.id,
  };
  candidate.messages.push(message);

  if (effect.target === "car") {
    entry.carBonuses[effect.stat] = (entry.carBonuses[effect.stat] || 0) + effect.delta;
    if (effect.stat === "speed") {
      candidate.lapDuration -= 0.3 * effect.delta * (1 - effect.progress);
      candidate.effectiveSpeed = clamp(candidate.effectiveSpeed + effect.delta, 1, 10);
    }
    if (effect.stat === "handling") {
      candidate.effectiveHandling = clamp(candidate.effectiveHandling + effect.delta, 1, 10);
    }
    return;
  }
  if (effect.target === "driver") {
    const bonuses = driverBonuses(entry, driver.id);
    bonuses[effect.stat] = (bonuses[effect.stat] || 0) + effect.delta;
    if (effect.stat === "pace") candidate.lapDuration -= 0.7 * effect.delta * (1 - effect.progress);
    if (effect.stat === "control") candidate.effectiveControl = clamp(candidate.effectiveControl + effect.delta, 1, 10);
    if (effect.stat === "overtaking") candidate.effectiveOvertaking = clamp(candidate.effectiveOvertaking + effect.delta, 1, 10);
    return;
  }
  if (effect.special === "reset") {
    entry.carWear = 0;
    entry.driverFatigue.set(driver.id, 0);
    return;
  }
  if (effect.special === "mark") {
    const bonuses = driverBonuses(entry, driver.id);
    bonuses.pace = (bonuses.pace || 0) + 1;
    bonuses.control = (bonuses.control || 0) - 2;
    bonuses.severity = (bonuses.severity || 0) + 1;
    bonuses.weird = (bonuses.weird || 0) + 2;
    candidate.effectiveControl = clamp(candidate.effectiveControl - 2, 1, 10);
    candidate.severityBonus += 1;
    message.markGranted = true;
    return;
  }
  if (effect.special === "dnf") {
    candidate.dnf = true;
    candidate.dnfProgress = effect.progress;
    return;
  }
  if (effect.special === "position") {
    const index = order.findIndex((item) => item.id === entry.id);
    if (index > 0) {
      const ahead = order[index - 1];
      order[index - 1] = entry;
      order[index] = ahead;
      candidate.lapDuration -= 4;
      message.relatedEntryId = ahead.id;
      message.positionJump = true;
    } else {
      candidate.lapDuration -= 15;
    }
  }
}

function applyCorner(candidates, segment, condition, random, progress) {
  for (const candidate of candidates.values()) {
    if (candidate.dnf) continue;
    const severity = clamp(segment.severity + candidate.severityBonus, 1, 6);
    candidate.lapDuration += severity + 5
      - (0.35 * candidate.effectiveControl + 0.15 * candidate.effectiveHandling);
    const denominator = weatherMishapFactor(condition)
      * (
        5
        + candidate.effectiveControl
        + candidate.effectiveHandling
        - severity
      );
    if (random() < 1 / Math.max(1, denominator)) {
      const penalty = cornerMishapPenalty(severity, random);
      addMishap(
        candidate,
        candidate.driver,
        random,
        random() < 0.5
          ? `${candidate.driver.name} has a mishap coming out of a severity ${severity} ${segment.type} and loses ${penalty} seconds.`
          : `${candidate.driver.name} isn't able to hold control in the severity ${severity} ${segment.type} and has a mishap, losing ${penalty} seconds.`,
        progress,
        penalty,
      );
    }
  }
}

function estimatedTimeAtProgress(candidate, progress) {
  return candidate.entry.elapsed + clamp(candidate.lapDuration, 30, 120) * progress;
}

function resolveStraight(order, candidates, straightNumber, random, progress) {
  const blockedPairs = new Set();
  for (let frontIndex = 0; frontIndex < order.length - 1; frontIndex += 1) {
    const defender = order[frontIndex];
    const attacker = order[frontIndex + 1];
    const pair = `${attacker.id}:${defender.id}`;
    if (blockedPairs.has(pair)) continue;

    const attacking = candidates.get(attacker.id);
    const defending = candidates.get(defender.id);
    if (!attacking || !defending || attacking.dnf || defending.dnf) continue;
    const gap = Math.max(
      0,
      estimatedTimeAtProgress(attacking, progress)
        - estimatedTimeAtProgress(defending, progress),
    );
    if (gap > 1) continue;

    if (!attackerWinsOvertake(
      attacking.effectiveOvertaking,
      defending.effectiveOvertaking,
      random,
    )) {
      attacking.messages.push({
        type: "overtake-denied",
        message: [
          `${defending.driver.name} sees ${attacking.driver.name} in the mirrors and is able to fend off the overtake.`,
          `${defending.driver.name} shuts down an overtake attempt by ${attacking.driver.name}.`,
          `${attacking.driver.name} goes for the overtake against ${defending.driver.name} but isn't able to pull it off.`,
        ][Math.floor(random() * 3)],
        progress,
        relatedEntryId: defender.id,
      });
      if (random() < 1 / 10) {
        addMishap(
          attacking,
          attacking.driver,
          random,
          `${attacking.driver.name} has a mishap after the denied overtake and loses 3 seconds.`,
          Math.min(0.98, progress + 0.01),
        );
      }
      continue;
    }

    attacking.lapDuration -= 2;
    attacking.messages.push({
      type: "overtake",
      message: [
        `${attacking.driver.name} just manages to slip past ${defending.driver.name} in the straight.`,
        `${attacking.driver.name} sees an opening and blows past ${defending.driver.name}.`,
        `${attacking.driver.name} leaves ${defending.driver.name} in the dust.`,
        `${attacking.driver.name} overtakes ${defending.driver.name} in the straight.`,
      ][Math.floor(random() * 4)],
      progress,
      relatedEntryId: defender.id,
    });
    if (random() < 1 / 20) {
      addMishap(
        defending,
        defending.driver,
        random,
        `${defending.driver.name} attempted to deny the overtake but suffered a mishap, losing 3 seconds.`,
        Math.min(0.98, progress + 0.01),
      );
    }
    order[frontIndex] = attacker;
    order[frontIndex + 1] = defender;
    blockedPairs.add(`${defender.id}:${attacker.id}`);
  }
}

export function selectRaceCondition(courseName, seed) {
  const random = randomGenerator(`condition:${seed}`);
  return conditionForRoll(courseByName(courseName), random());
}

export function simulateRace(entries, seed = "opening-bell", options = {}) {
  const random = randomGenerator(seed);
  const course = courseByName(options.courseName);
  const condition = options.condition || conditionForRoll(course, random());
  const racers = entries.map((entry) => ({
    ...entry,
    completedLaps: 0,
    elapsed: 0,
    lastLapTime: null,
    finishTime: null,
    status: "running",
    carWear: 0,
    carBonuses: {},
    driverFatigue: new Map(),
    driverBonuses: new Map(),
    lapRecords: [],
    dnfTime: null,
    dnfProgress: 0,
    dnfDriver: null,
    uniqueDrivers: [...new Map(
      entry.stints.map((stint) => [stint.driver.id, stint.driver]),
    ).values()],
  }));
  const raceStartMessages = [
    "Blessed be The Stewards, their wisdom ever-expanding, and may Velocitus smile upon this race today. They're Off!",
    "The Speed God shall surely triumph over the drudgery of The Decelerator this day. The race is on!",
    "The Stewards, in all their blinding radiance, have anointed this course and these drivers on this fine day. May the best racer win!",
  ];
  const events = [{
    time: 0,
    type: "race-start",
    message: raceStartMessages[Math.floor(random() * raceStartMessages.length)],
    condition,
    course: courseSummary(course),
    standings: snapshot(racers, 0),
  }, {
    time: 3,
    type: "grid-chaos",
    message: "The grid becomes a mess as drivers jockey for position!",
    standings: snapshot(racers, 0),
  }];

  for (let lap = 1; lap <= TOTAL_LAPS; lap += 1) {
    const activeRacers = racers.filter((entry) => entry.status === "running");
    if (!activeRacers.length) break;
    const order = rankEntries(activeRacers);
    const candidates = new Map(
      activeRacers.map((entry) => [
        entry.id,
        lapCandidate(entry, lap, course, condition, random),
      ]),
    );
    let straightNumber = 0;
    for (const [segmentIndex, segment] of course.segments.entries()) {
      const progress = (segmentIndex + 0.5) / course.segments.length;
      for (const candidate of candidates.values()) {
        if (
          candidate.strangeEffect
          && !candidate.strangeEffect.applied
          && candidate.strangeEffect.progress <= progress
        ) {
          applyStrangeEffect(candidate, order);
        }
      }
      if (segment.type === "straight") {
        straightNumber += 1;
        resolveStraight(order, candidates, straightNumber, random, progress);
      } else {
        applyCorner(candidates, segment, condition, random, progress);
      }
    }
    for (const candidate of candidates.values()) applyStrangeEffect(candidate, order);

    for (let index = 1; index < order.length; index += 1) {
      const ahead = candidates.get(order[index - 1].id);
      const behind = candidates.get(order[index].id);
      if (
        ahead
        && behind
        && !ahead.dnf
        && !behind.dnf
        && behind.messages.some((message) => (
          message.type === "overtake" || message.positionJump
        ))
      ) {
        behind.lapDuration = Math.min(
          behind.lapDuration,
          ahead.entry.elapsed + ahead.lapDuration - behind.entry.elapsed - 0.01,
        );
      }
    }

    const crossings = activeRacers.map((entry) => {
      const candidate = candidates.get(entry.id);
      return {
        ...candidate,
        crossingTime: entry.elapsed + clamp(candidate.lapDuration, 30, 120),
      };
    }).sort((a, b) => a.crossingTime - b.crossingTime);

    for (const crossing of crossings) {
      const { entry, driver, crossingTime } = crossing;
      const lapStart = entry.elapsed;
      if (crossing.dnf) {
        const dnfTime = lapStart + (crossingTime - lapStart) * crossing.dnfProgress;
        entry.elapsed = dnfTime;
        entry.status = "dnf";
        entry.dnfTime = dnfTime;
        entry.dnfProgress = crossing.dnfProgress;
        entry.dnfDriver = driver;
        for (const message of crossing.messages) {
          const eventTime = lapStart + (crossingTime - lapStart) * message.progress;
          if (
            lap === 1
            && eventTime <= 6
            && (message.type === "overtake" || message.type === "overtake-denied")
          ) continue;
          events.push({
            time: eventTime,
            type: message.type,
            entryId: entry.id,
            relatedEntryId: message.relatedEntryId,
            message: message.message,
            lap,
            segmentProgress: message.progress,
            category: "event",
            tone: message.tone,
            racerId: message.racerId,
            markGranted: message.markGranted,
            positionJump: message.positionJump,
          });
        }
        continue;
      }
      entry.lastLapTime = crossingTime - entry.elapsed;
      entry.elapsed = crossingTime;
      entry.completedLaps = lap;
      entry.lapRecords.push({
        lap,
        start: lapStart,
        end: crossingTime,
        driver,
      });
      for (const message of crossing.messages) {
        const eventTime = lapStart + (crossingTime - lapStart) * message.progress;
        if (
          lap === 1
          && eventTime <= 6
          && (message.type === "overtake" || message.type === "overtake-denied")
        ) continue;
        events.push({
          time: eventTime,
          type: message.type,
          entryId: entry.id,
          relatedEntryId: message.relatedEntryId,
          message: message.message,
          lap,
          segmentProgress: message.progress,
          category: "event",
          tone: message.tone,
          racerId: message.racerId,
          markGranted: message.markGranted,
          positionJump: message.positionJump,
        });
      }

      if (lap === TOTAL_LAPS) {
        const isFirstFinisher = !racers.some((racer) => racer.finishTime !== null);
        entry.finishTime = crossingTime;
        entry.status = "finished";
        events.push({
          time: crossingTime,
          type: isFirstFinisher ? "winner" : "finish",
          entryId: entry.id,
          message: isFirstFinisher
            ? [
              `Winner: ${driver.name} in ${entry.carName} finishes first with a total time of ${formatRaceTime(crossingTime)}! The Speed God smiles upon us today!`,
              `Winner: ${driver.name} in ${entry.carName} finishes first with a total time of ${formatRaceTime(crossingTime)}! The Stewards, in their infinite glory, have truly blessed us!`,
            ][Math.floor(random() * 2)]
            : `${driver.name} in ${entry.carName} crosses the finish line in P${rankEntries(racers).findIndex((racer) => racer.id === entry.id) + 1} with a time of ${formatRaceTime(crossingTime)}.`,
          standings: snapshot(racers, crossingTime),
        });
      } else {
        const standings = snapshot(racers, crossingTime);
        const position = standings.findIndex((standing) => standing.id === entry.id);
        const notable = lap === 1 || [10, 20, 30, 40, 50].includes(lap);
        events.push({
          time: crossingTime,
          type: notable ? "lap" : "timing",
          entryId: entry.id,
          message: notable ? `${entry.carName} (${driver.name}) completes lap ${lap} in P${position + 1}.` : "",
          standings,
        });
      }
    }

    for (const entry of activeRacers.filter((item) => item.status === "running")) {
      const driver = driverForLap(entry, lap);
      updateFatigue(entry, driver, entry.vehicle.feedback);
      const bonuses = driverBonuses(entry, driver.id);
      const effectiveDurability = clamp(
        entry.vehicle.durability + (entry.carBonuses.durability || 0),
        1,
        10,
      );
      const effectiveTechnical = clamp(
        driver.technical + (bonuses.technical || 0),
        1,
        10,
      );
      const wearPerLap = degradationOverForty(effectiveDurability)
        / 40
        * (1 - mitigation(effectiveTechnical));
      entry.carWear += wearPerLap;
    }
  }

  const lastFinishTime = Math.max(...racers.map((entry) => entry.finishTime ?? entry.dnfTime ?? 0));
  const podium = rankEntries(racers).filter((entry) => entry.status === "finished").slice(0, 3);
  const podiumTime = lastFinishTime + 0.01;
  if (podium.length) {
    events.push({
      time: podiumTime,
      type: "podium",
      message: `Official podium: ${podium.map((entry, index) => `P${index + 1} ${entry.carName}`).join(", ")}.`,
    });
  }
  for (const event of events) {
    event.standings = applyEventPosition(
      snapshotAtTime(racers, event.time),
      event,
    );
  }
  const duration = podiumTime;
  addActionEvents(events, racers, duration, random);
  const throttledEvents = throttleFeedEvents(events);
  return {
    seed,
    course: courseSummary(course),
    condition,
    duration,
    events: throttledEvents,
    finalStandings: snapshot(racers, Math.max(...racers.map((entry) => entry.elapsed))),
  };
}

export function formatRaceTime(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
