import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  buildEntries, defaultCarNames, defaultLineup, teams,
} from "./league-data.mjs";
import { generateRacerNames } from "./racer-names.mjs";
import { COURSES } from "./courses.mjs";
import {
  appendStrangeEffectSummary, basePartDuration, personalizeRaceFeedMessage,
  formatRaceTime, selectRaceCondition, simulateRace, TOTAL_LAPS,
} from "./simulation.mjs";

const TRAINABLE_STATS = [
  "pace",
  "control",
  "overtaking",
  "stamina",
  "technical",
  "weird",
];
const CAR_STATS = ["speed", "handling", "durability", "feedback", "weird"];
const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0];
const RACES_PER_WEEK = 5;
const WEEKS_PER_SEASON = 4;
const SEASON_RACES = RACES_PER_WEEK * WEEKS_PER_SEASON;
const QUALIFIER_LOCK_MS = 10 * 60 * 1000;
const MVD_OPENER_BONUS_UNITS = 0.01 * TOTAL_LAPS;
const MVD_CLOSER_BONUS_UNITS = 0.02 * TOTAL_LAPS;
const LEAGUE_CODE = "shreveport";
const STEWARD_USERNAME = "devman";
const STEWARD_PASSWORD = "devman";
const TRACKS = COURSES.map((course) => course.name);
const PRONOUNS = ["She/Her", "He/Him", "They/Them", "It/It"];
const COURSE_CODES = {
  "Race City": "R",
  "New Torque City": "N",
  Acceleton: "A",
  Suzuka: "S",
};
const ROLE_CODES = {
  Opener: "O",
  Bridge: "B",
  Closer: "C",
};
export const BRAND_COLORS = [
  "#DB0000", "#0042F5", "#2E8F26", "#FF5310",
  "#FFD202", "#5202B0", "#59F7CF", "#6A73FF",
  "#7A503E", "#707070", "#000000", "#FF3ECE",
];

function normalizeUsername(username) {
  const normalized = String(username || "").trim().toLocaleLowerCase();
  if (normalized.length < 3 || normalized.length > 24) {
    throw new Error("Username must be 3 to 24 characters.");
  }
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error("Username can only use letters, numbers, underscores, and dashes.");
  }
  return normalized;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 6) throw new Error("Password must be at least 6 characters.");
  if (value.length > 128) throw new Error("Password must be 128 characters or fewer.");
  return value;
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function leagueOriginForRacer(racer) {
  const rookieMatch = String(racer.id).match(/^rookie-(\d+)-/);
  if (rookieMatch) return `Season ${rookieMatch[1]} Rookie Draft`;
  const seasonalDraftMatch = String(racer.id).match(/^draft-(\d+)-\d+-\d+$/);
  if (seasonalDraftMatch) return `Season ${seasonalDraftMatch[1]} Opening Draft`;
  return "Season 1 Opening Draft";
}

const LEAGUE_TIME_ZONE = "America/New_York";
const LEAGUE_RACE_HOUR = 20;
const LEAGUE_RACE_MINUTE = 0;
const easternDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: LEAGUE_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function easternParts(date) {
  const parts = Object.fromEntries(
    easternDateTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function easternOffsetMs(date) {
  const parts = easternParts(date);
  const wallTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallTimeAsUtc - date.getTime();
}

function easternWallTimeToDate(parts, hour = LEAGUE_RACE_HOUR, minute = LEAGUE_RACE_MINUTE) {
  const wallTimeAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
  let utcTime = wallTimeAsUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    utcTime = wallTimeAsUtc - easternOffsetMs(new Date(utcTime));
  }
  return new Date(utcTime);
}

function addEasternDays(parts, days) {
  return easternParts(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0)));
}

function isEasternWeekend(parts) {
  return parts.weekday === "Sat" || parts.weekday === "Sun";
}

function nextEasternRaceDate(parts) {
  let raceParts = parts;
  while (isEasternWeekend(raceParts)) {
    raceParts = addEasternDays(raceParts, 1);
  }
  return easternWallTimeToDate(raceParts);
}

function firstRaceAtForDraft(startedAt) {
  const draftStart = new Date(startedAt);
  let raceParts = easternParts(draftStart);
  let raceAt = easternWallTimeToDate(raceParts);
  if (draftStart >= raceAt) {
    raceParts = addEasternDays(raceParts, 1);
    raceAt = easternWallTimeToDate(raceParts);
  }
  raceAt = nextEasternRaceDate(easternParts(raceAt));
  return raceAt.toISOString();
}

function scheduledRaceAtForIndex(firstRaceAt, raceIndex) {
  let raceParts = easternParts(new Date(firstRaceAt));
  let raceAt = easternWallTimeToDate(raceParts);
  for (let index = 0; index < raceIndex; index += 1) {
    raceParts = addEasternDays(easternParts(raceAt), 1);
    raceAt = nextEasternRaceDate(raceParts);
  }
  return raceAt.toISOString();
}

function nextAvailableRaceAt(firstRaceAt, raceIndex, now = new Date()) {
  const raceAt = new Date(scheduledRaceAtForIndex(firstRaceAt, raceIndex));
  while (raceAt.getTime() + (2 * 60 * 60 * 1000) < now.getTime()) {
    const nextRaceAt = nextEasternRaceDate(addEasternDays(easternParts(raceAt), 1));
    raceAt.setTime(nextRaceAt.getTime());
  }
  return raceAt.toISOString();
}

function nextWeekdayRaceAt(previousRaceAt) {
  return nextEasternRaceDate(addEasternDays(easternParts(new Date(previousRaceAt)), 1)).toISOString();
}

function seasonFromWeekKey(week) {
  return Math.floor((week - 1) / WEEKS_PER_SEASON) + 1;
}

function displayWeekForKey(week) {
  return ((week - 1) % WEEKS_PER_SEASON) + 1;
}

function compareChampionshipRecords(a, b) {
  if (a.pointUnits !== b.pointUnits) return b.pointUnits - a.pointUnits;
  for (let position = 0; position < RACE_POINTS.length; position += 1) {
    if (a.finishCounts[position] !== b.finishCounts[position]) {
      return b.finishCounts[position] - a.finishCounts[position];
    }
  }
  return String(a.sortName).localeCompare(String(b.sortName));
}

function championshipRecordsTied(a, b) {
  return a.pointUnits === b.pointUnits
    && a.finishCounts.every((count, index) => count === b.finishCounts[index]);
}

function rankChampionshipRecords(records) {
  const sorted = [...records].sort(compareChampionshipRecords);
  const ranked = [];
  sorted.forEach((record, index) => {
    ranked.push({
      ...record,
      points: record.pointUnits / TOTAL_LAPS,
      rank: index > 0 && championshipRecordsTied(record, sorted[index - 1])
        ? ranked[index - 1].rank
        : index + 1,
    });
  });
  return ranked;
}

function finalDriverForEntry(entry) {
  return entry?.stints?.at(-1)?.driver?.name || "an unknown closer";
}

function teamNameForEntry(entry) {
  return entry?.teamName
    || teams.find((team) => team.id === entry?.teamId)?.name
    || "their team";
}

function eventDriverName(event, entryId) {
  return event.standings?.find((standing) => standing.id === entryId)?.driver || null;
}

function entryDriverAtLap(entry, lap) {
  const safeLap = Math.max(1, Math.min(TOTAL_LAPS, Number(lap) || 1));
  return entry?.stints?.find((stint) => safeLap >= stint.start && safeLap <= stint.end)?.driver
    || entry?.stints?.[0]?.driver
    || null;
}

function recapChoice(options, key) {
  if (!options.length) return "";
  return options[Math.abs(hashText(key)) % options.length];
}

function recapList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function isRookieOrigin(racer) {
  return String(racer?.id || "").startsWith("rookie-")
    || String(racer?.source || "").startsWith("rookie-");
}

function winnerTimeFromRace(race) {
  const winnerEvent = (race.events || []).find((event) => event.type === "winner");
  return winnerEvent?.message?.match(/total time of ([^!]+)!/)?.[1] || null;
}

function finishSeconds(standing) {
  return Number.isFinite(standing?.finishTime)
    ? standing.finishTime
    : Number.isFinite(standing?.elapsed)
      ? standing.elapsed
      : null;
}

function teamOutcomeGroups(standings, entriesById) {
  const groups = new Map();
  for (const standing of standings) {
    const entry = entriesById.get(standing.id);
    if (!entry) continue;
    const group = groups.get(entry.teamId) || {
      teamId: entry.teamId,
      teamName: teamNameForEntry(entry),
      cars: [],
    };
    const positionIndex = standing.position - 1;
    group.cars.push({
      entry,
      standing,
      points: standing.status === "dnf" ? 0 : RACE_POINTS[positionIndex] ?? 0,
    });
    groups.set(entry.teamId, group);
  }
  return [...groups.values()].filter((group) => group.cars.length >= 2);
}

function bestTeamTopSix(standings, entriesById) {
  return teamOutcomeGroups(standings, entriesById)
    .filter((group) => group.cars.every((car) => car.standing.status !== "dnf" && car.standing.position <= 6))
    .sort((a, b) => (
      a.cars.reduce((sum, car) => sum + car.standing.position, 0)
      - b.cars.reduce((sum, car) => sum + car.standing.position, 0)
      || Math.min(...a.cars.map((car) => car.standing.position))
        - Math.min(...b.cars.map((car) => car.standing.position))
      || b.cars.reduce((sum, car) => sum + car.points, 0)
        - a.cars.reduce((sum, car) => sum + car.points, 0)
    ))[0] || null;
}

function worstTeamNoPoints(standings, entriesById) {
  return teamOutcomeGroups(standings, entriesById)
    .filter((group) => group.cars.every((car) => car.points <= 0))
    .sort((a, b) => (
      b.cars.filter((car) => car.standing.status === "dnf").length
      - a.cars.filter((car) => car.standing.status === "dnf").length
      || b.cars.reduce((sum, car) => sum + car.standing.position, 0)
        - a.cars.reduce((sum, car) => sum + car.standing.position, 0)
    ))[0] || null;
}

function closeFinishMoment(standings, entriesById) {
  const finishers = standings
    .filter((standing) => standing.status !== "dnf" && Number.isFinite(finishSeconds(standing)))
    .sort((a, b) => a.position - b.position);
  const moments = [];
  for (let index = 1; index < finishers.length; index += 1) {
    const ahead = finishers[index - 1];
    const behind = finishers[index];
    const gap = finishSeconds(behind) - finishSeconds(ahead);
    if (gap >= 0 && gap <= 3) {
      moments.push({
        ahead,
        behind,
        gap,
        weight: (ahead.position <= 3 ? 4 : 0)
          + (ahead.position === 10 && behind.position === 11 ? 3 : 0)
          + (3 - gap),
      });
    }
  }
  return moments
    .sort((a, b) => b.weight - a.weight)[0]
    ? {
      ...moments.sort((a, b) => b.weight - a.weight)[0],
      aheadCar: entriesById.get(moments.sort((a, b) => b.weight - a.weight)[0].ahead.id)?.carName,
      behindCar: entriesById.get(moments.sort((a, b) => b.weight - a.weight)[0].behind.id)?.carName,
    }
    : null;
}

function leadDurations(race, entriesById) {
  const snapshots = (race.events || [])
    .filter((event) => event.standings?.length && event.time >= 0)
    .map((event) => ({
      time: Math.min(event.time, race.duration || event.time),
      leaderId: event.standings[0]?.id,
    }))
    .filter((snapshot) => snapshot.leaderId);
  snapshots.push({
    time: race.duration || Math.max(...snapshots.map((snapshot) => snapshot.time), 0),
    leaderId: race.finalStandings?.[0]?.id,
  });
  const durations = new Map();
  for (let index = 0; index < snapshots.length - 1; index += 1) {
    const current = snapshots[index];
    const next = snapshots[index + 1];
    const span = Math.max(0, next.time - current.time);
    durations.set(current.leaderId, (durations.get(current.leaderId) || 0) + span);
  }
  const leader = [...durations.entries()]
    .sort((a, b) => b[1] - a[1])[0];
  return leader
    ? {
      entryId: leader[0],
      duration: leader[1],
      carName: entriesById.get(leader[0])?.carName,
    }
    : null;
}

function lateRaceMovement(race, entriesById) {
  const snapshots = (race.events || [])
    .filter((event) => event.standings?.length && event.time >= 0)
    .sort((a, b) => a.time - b.time);
  const lateSnapshot = snapshots.find((event) => (
    event.standings.some((standing) => standing.completedLaps >= 50)
  )) || snapshots.at(-1);
  if (!lateSnapshot) return { charge: null, collapse: null };
  const finalById = new Map(race.finalStandings.map((standing) => [standing.id, standing]));
  const changes = lateSnapshot.standings
    .map((standing) => {
      const final = finalById.get(standing.id);
      return final
        ? {
          entry: entriesById.get(standing.id),
          oldPosition: standing.position,
          finalPosition: final.position,
          delta: standing.position - final.position,
        }
        : null;
    })
    .filter((item) => item?.entry);
  return {
    charge: [...changes].filter((item) => item.delta >= 3).sort((a, b) => b.delta - a.delta)[0] || null,
    collapse: [...changes].filter((item) => item.delta <= -3).sort((a, b) => a.delta - b.delta)[0] || null,
  };
}

function raceStreaks(race, priorRaceRows = []) {
  const rows = [...priorRaceRows]
    .filter((row) => row.season === race.season && row.id !== race.id)
    .sort((a, b) => a.id - b.id)
    .map((row) => ({
      id: row.id,
      standings: JSON.parse(row.standings_json),
    }));
  rows.push({
    id: race.id,
    standings: race.finalStandings,
  });
  const latestByEntry = new Map();
  for (const row of rows) {
    for (const standing of row.standings) {
      const list = latestByEntry.get(standing.id) || [];
      list.push(standing);
      latestByEntry.set(standing.id, list);
    }
  }
  const streaks = [];
  for (const [entryId, list] of latestByEntry) {
    const current = list.at(-1);
    const topHalf = current.status !== "dnf" && current.position <= 6;
    let count = 0;
    for (const standing of [...list].reverse()) {
      const matches = topHalf
        ? standing.status !== "dnf" && standing.position <= 6
        : standing.status === "dnf" || standing.position > 6;
      if (!matches) break;
      count += 1;
    }
    if (count >= 3) streaks.push({ entryId, topHalf, count });
  }
  return streaks.sort((a, b) => b.count - a.count)[0] || null;
}

function generateRaceRecap(race, context = {}) {
  if (!race?.finalStandings?.length) return "";
  const entriesById = new Map((race.entries || []).map((entry) => [entry.id, entry]));
  const standings = race.finalStandings;
  const winner = standings[0];
  const winnerEntry = entriesById.get(winner.id);
  const winnerDriver = finalDriverForEntry(winnerEntry);
  const winnerTeam = teamNameForEntry(winnerEntry);
  const condition = race.condition || "Sunny";
  const poleEntry = (race.entries || []).find((entry) => entry.startingGridPosition === 1);
  const winnerTime = winnerTimeFromRace(race)
    || (Number.isFinite(winner.finishTime) ? formatRaceTime(winner.finishTime) : formatRaceTime(race.duration || 0));
  const keyPrefix = `${race.seed || race.id || race.courseName}:${race.week}:${race.raceNumber}`;

  const winnerTemplates = {
    Sunny: [
      `A beautiful, sunny ${race.courseName} belonged to ${winnerEntry?.carName || winner.id}, with ${winnerDriver} bringing home a victory for ${winnerTeam} at ${winnerTime}.`,
      `The sunny day at ${race.courseName} was won by ${winnerTeam}, as ${winnerDriver} brought home the gold in ${winnerEntry?.carName || winner.id} with a final time of ${winnerTime}.`,
    ],
    Raining: [
      `A dreary, rainy ${race.courseName} belonged to ${winnerEntry?.carName || winner.id}, with ${winnerDriver} bringing home a victory for ${winnerTeam} at ${winnerTime}.`,
      `The stormy day at ${race.courseName} was won by ${winnerTeam}, as ${winnerDriver} brought home the gold in ${winnerEntry?.carName || winner.id} with a final time of ${winnerTime}.`,
    ],
    Snowing: [
      `A frigid, snowing ${race.courseName} belonged to ${winnerEntry?.carName || winner.id}, with ${winnerDriver} bringing home a victory for ${winnerTeam} at ${winnerTime}.`,
      `The snowy day at ${race.courseName} was won by ${winnerTeam}, as ${winnerDriver} brought home the gold in ${winnerEntry?.carName || winner.id} with a final time of ${winnerTime}.`,
    ],
    Churning: [
      `As the air churned and roiled, ${race.courseName} belonged to ${winnerEntry?.carName || winner.id}, with ${winnerDriver} bringing home a victory for ${winnerTeam} at ${winnerTime}.`,
      `At the heart of an ethereal tempest, ${race.courseName} was won by ${winnerTeam} as ${winnerDriver} brought home the gold in ${winnerEntry?.carName || winner.id} with a final time of ${winnerTime}.`,
    ],
  };

  const movers = standings
    .map((standing) => {
      const entry = entriesById.get(standing.id);
      return {
        standing,
        entry,
        delta: Number.isFinite(entry?.startingGridPosition)
          ? entry.startingGridPosition - standing.position
          : 0,
      };
    })
    .filter((item) => item.entry);
  const biggestGain = [...movers].sort((a, b) => b.delta - a.delta)[0];
  const podiumDrop = [...movers]
    .filter((item) => item.entry.startingGridPosition <= 3 && item.standing.position > 6)
    .sort((a, b) => a.entry.startingGridPosition - b.entry.startingGridPosition)[0];
  const poleDominated = poleEntry
    && winner.id === poleEntry.id
    && (race.events || []).every((event) => (
      !event.standings?.length || event.standings[0].id === poleEntry.id
    ));

  const pairCounts = new Map();
  for (const event of race.events || []) {
    if (!["overtake", "overtake-denied"].includes(event.type) || !event.relatedEntryId) continue;
    const ids = [event.entryId, event.relatedEntryId].sort().join(":");
    const current = pairCounts.get(ids) || {
      count: 0,
      overtakes: 0,
      denials: 0,
      wins: new Map(),
      attackerNames: new Set(),
      defenderNames: new Set(),
      entryIds: [event.entryId, event.relatedEntryId],
    };
    current.count += 1;
    if (event.type === "overtake") current.overtakes += 1;
    if (event.type === "overtake-denied") current.denials += 1;
    const winningEntryId = event.type === "overtake" ? event.entryId : event.relatedEntryId;
    current.wins.set(winningEntryId, (current.wins.get(winningEntryId) || 0) + 1);
    const attackerName = eventDriverName(event, event.entryId);
    const defenderName = eventDriverName(event, event.relatedEntryId);
    if (attackerName) current.attackerNames.add(attackerName);
    if (defenderName) current.defenderNames.add(defenderName);
    pairCounts.set(ids, current);
  }
  const rivalry = [...pairCounts.values()]
    .sort((a, b) => b.count - a.count || b.overtakes - a.overtakes)[0];

  const incidentCounts = new Map();
  for (const event of race.events || []) {
    if (!["incident", "spin"].includes(event.type)) continue;
    const entry = entriesById.get(event.entryId);
    if (!entry) continue;
    const current = incidentCounts.get(event.entryId) || {
      count: 0,
      spins: 0,
      cornerMishaps: 0,
      overtakeMishaps: 0,
      carName: entry.carName,
    };
    if (event.type === "spin") {
      current.spins += 1;
    } else {
      current.count += 1;
      if (/severity \d+ (turn|chicane)/i.test(event.message || "")) current.cornerMishaps += 1;
      if (/overtake/i.test(event.message || "")) current.overtakeMishaps += 1;
    }
    incidentCounts.set(event.entryId, current);
  }
  const incidentLeader = [...incidentCounts.values()]
    .sort((a, b) => (b.count + b.spins) - (a.count + a.spins) || b.spins - a.spins)[0];
  const strangeEvents = (race.events || []).filter((event) => event.type === "strange");
  const strangeByDriver = new Map();
  for (const event of strangeEvents) {
    const driver = eventDriverName(event, event.entryId);
    if (driver) strangeByDriver.set(driver, (strangeByDriver.get(driver) || 0) + 1);
  }
  const strangeDriver = [...strangeByDriver.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const positiveChurnDrivers = [...new Set(strangeEvents
    .filter((event) => condition === "Churning" && event.tone === "good" && /Churning/i.test(event.message || ""))
    .map((event) => eventDriverName(event, event.entryId))
    .filter(Boolean))];
  const negativeChurnDrivers = [...new Set(strangeEvents
    .filter((event) => condition === "Churning" && event.tone === "bad" && /Churning/i.test(event.message || ""))
    .map((event) => eventDriverName(event, event.entryId))
    .filter(Boolean))];
  const negativeChurnTeams = [...new Set(strangeEvents
    .filter((event) => condition === "Churning" && event.tone === "bad" && /Churning/i.test(event.message || ""))
    .map((event) => teamNameForEntry(entriesById.get(event.entryId)))
    .filter(Boolean))];
  const dnfEntries = standings.filter((standing) => standing.status === "dnf");
  const closeFinish = closeFinishMoment(standings, entriesById);
  const leadLeader = leadDurations(race, entriesById);
  const lateMovement = lateRaceMovement(race, entriesById);
  const teamTopSix = bestTeamTopSix(standings, entriesById);
  const teamDisaster = worstTeamNoPoints(standings, entriesById);
  const streak = raceStreaks(race, context.priorRaces || []);
  const rookieDebuts = context.debuts?.rookies || [];
  const veteranSeasonDebuts = context.debuts?.veterans || [];
  const spinEvents = (race.events || [])
    .filter((event) => event.type === "spin")
    .map((event) => ({
      event,
      carName: entriesById.get(event.entryId)?.carName,
      driverName: eventDriverName(event, event.entryId),
    }))
    .filter((spin) => spin.carName || spin.driverName);
  const cleanContender = standings
    .filter((standing) => standing.status !== "dnf" && standing.position <= 4)
    .find((standing) => !incidentCounts.has(standing.id));
  const messyResult = standings
    .map((standing) => {
      const incidents = incidentCounts.get(standing.id);
      return incidents
        ? {
          standing,
          incidents,
          total: incidents.count + incidents.spins,
        }
        : null;
    })
    .filter((item) => item && (item.standing.position <= 3 || item.total >= 2))
    .sort((a, b) => (
      (a.standing.position <= 3 ? -1 : 0) - (b.standing.position <= 3 ? -1 : 0)
      || b.total - a.total
    ))[0];
  const oneSidedRivalry = rivalry && rivalry.count >= 3
    ? [...rivalry.wins.entries()].sort((a, b) => b[1] - a[1])[0]
    : null;

  const paragraphOneParts = [recapChoice(winnerTemplates[condition] || winnerTemplates.Sunny, `${keyPrefix}:winner`)];
  if (poleDominated) {
    paragraphOneParts.push(`${poleEntry.carName} absolutely dominated, starting in pole position and refusing to be dethroned for 60 glorious laps until ultimately taking home gold!`);
  } else if (poleEntry) {
    paragraphOneParts.push(recapChoice([
      `${poleEntry.carName} started from pole, leaving the rest of the grid to fight for position.`,
      `${poleEntry.carName} shined during qualifiers, locking in pole position on the starting grid.`,
      `${poleEntry.carName} started from pole, with the rest of the grid breathing down their neck.`,
    ], `${keyPrefix}:pole`));
  } else {
    paragraphOneParts.push("The starting grid settled quickly, proving to hold some fierce competition.");
  }
  const paragraphOneBeats = [];
  if (closeFinish?.aheadCar && closeFinish?.behindCar) {
    const tied = closeFinish.gap < 0.01;
    const gap = tied ? "a dead heat" : `${closeFinish.gap.toFixed(2)} seconds`;
    paragraphOneBeats.push(tied
      ? recapChoice([
        `${closeFinish.aheadCar} and ${closeFinish.behindCar} hit the line in a dead heat, leaving the timing tower to settle the matter by sacred decimals.`,
        `The finish between ${closeFinish.aheadCar} and ${closeFinish.behindCar} was effectively tied, a little act of violence against anyone who likes clean columns.`,
        `${closeFinish.aheadCar} and ${closeFinish.behindCar} finished so closely that the race briefly became a theological problem for the timing system.`,
      ], `${keyPrefix}:finish-tie`)
      : recapChoice([
        `${closeFinish.aheadCar} and ${closeFinish.behindCar} crossed the line separated by only ${gap}, turning the finish into a razor-thin blessing of speed.`,
        `The timing tower nearly split in half trying to separate ${closeFinish.aheadCar} from ${closeFinish.behindCar}, with just ${gap} between them at the finish.`,
        `${closeFinish.aheadCar} barely held off ${closeFinish.behindCar}, the two cars finishing within ${gap} of one another after 60 laps of pressure.`,
      ], `${keyPrefix}:close-finish`));
  }
  if (lateMovement.charge) {
    paragraphOneBeats.push(recapChoice([
      `${lateMovement.charge.entry.carName} found another gear late, climbing from P${lateMovement.charge.oldPosition} around lap 50 to finish P${lateMovement.charge.finalPosition}.`,
      `The final stretch belonged to ${lateMovement.charge.entry.carName}, who turned a late P${lateMovement.charge.oldPosition} running order into a P${lateMovement.charge.finalPosition} finish.`,
      `${lateMovement.charge.entry.carName} refused to stay buried, surging late from P${lateMovement.charge.oldPosition} to P${lateMovement.charge.finalPosition} before the checkered judgment fell.`,
    ], `${keyPrefix}:late-charge`));
  }
  if (lateMovement.collapse) {
    paragraphOneBeats.push(recapChoice([
      `${lateMovement.collapse.entry.carName} looked secure around lap 50 in P${lateMovement.collapse.oldPosition}, but the last act was cruel, dropping them to P${lateMovement.collapse.finalPosition}.`,
      `The closing laps punished ${lateMovement.collapse.entry.carName}, turning a late P${lateMovement.collapse.oldPosition} run into a P${lateMovement.collapse.finalPosition} finish.`,
      `${lateMovement.collapse.entry.carName} had glory in reach late, only for the road to take it back and leave them P${lateMovement.collapse.finalPosition}.`,
    ], `${keyPrefix}:late-collapse`));
  }
  if (leadLeader?.carName && leadLeader.duration > 60) {
    paragraphOneBeats.push(recapChoice([
      `${leadLeader.carName} spent the longest stretch in first place, leading for roughly ${formatRaceTime(leadLeader.duration)} before the final order settled.`,
      `No car held the front longer than ${leadLeader.carName}, which controlled the race for about ${formatRaceTime(leadLeader.duration)} total.`,
      `${leadLeader.carName} owned the clean air more than anyone else, holding P1 for approximately ${formatRaceTime(leadLeader.duration)}.`,
    ], `${keyPrefix}:lead-duration`));
  }
  if (biggestGain?.delta > 3) {
    paragraphOneBeats.push(recapChoice([
      `${biggestGain.entry.carName} made the biggest climb, rising ${biggestGain.delta} places from its start to finish P${biggestGain.standing.position}.`,
      `Not to be outdone, ${biggestGain.entry.carName} shot through the ranks, rising ${biggestGain.delta} places from its grid start to finish P${biggestGain.standing.position}.`,
      `${biggestGain.entry.carName} had a spectacular race, climbing ${biggestGain.delta} places from its grid position of ${biggestGain.entry.startingGridPosition} to finish in P${biggestGain.standing.position}.`,
    ], `${keyPrefix}:gain`));
  } else if (podiumDrop) {
    paragraphOneBeats.push(recapChoice([
      `${podiumDrop.entry.carName} had a rough slide, falling ${Math.abs(podiumDrop.delta)} places from P${podiumDrop.entry.startingGridPosition} to a disappointing final P${podiumDrop.standing.position}.`,
      `${podiumDrop.entry.carName} had a disappointing race, falling ${Math.abs(podiumDrop.delta)} places from P${podiumDrop.entry.startingGridPosition} to a final P${podiumDrop.standing.position}.`,
    ], `${keyPrefix}:drop`));
  }
  paragraphOneParts.push(
    paragraphOneBeats[Math.abs(hashText(`${keyPrefix}:paragraph-one-beat`)) % Math.max(1, paragraphOneBeats.length)]
      || recapChoice([
        "The final order mostly reflected the starting grid, with small margins deciding the day more than any one single move.",
        "Overall, cars remained close to their starting positions, with small battles throughout the race deciding who would ultimately take the podium.",
        "No single rupture defined the race; the result came from dozens of small judgments made at speed.",
      ], `${keyPrefix}:stable-grid`),
  );

  const paragraphTwoCandidates = [];
  if (spinEvents.length) {
    const spinCars = [...new Set(spinEvents.map((spin) => spin.carName).filter(Boolean))];
    const firstSpin = spinEvents[0];
    paragraphTwoCandidates.push({
      priority: 100,
      text: spinEvents.length === 1
        ? recapChoice([
          `${firstSpin.driverName || "A driver"} spun out in ${firstSpin.carName || "their car"}, losing precious time before dragging the car back into the race.`,
          `${firstSpin.carName || "One car"} gave the crowd a sharp intake of breath when ${firstSpin.driverName || "its driver"} spun out and had to gather the machine back up.`,
          `The race briefly tilted sideways for ${firstSpin.driverName || "one driver"}, who spun ${firstSpin.carName || "their car"} and surrendered a chunk of time to the track.`,
        ], `${keyPrefix}:single-spin`)
        : recapChoice([
          `The track claimed multiple victims, as ${recapList(spinCars)} suffered spin-outs before the day was done.`,
          `Spin-outs struck more than once, turning ${recapList(spinCars)} into unwilling offerings to The Decelerator.`,
          `The Stewards recorded ${spinEvents.length} spin-outs across the field, each one a little sermon on humility.`,
        ], `${keyPrefix}:multi-spin`),
    });
  }
  if (rivalry && rivalry.count >= 2) {
    const firstCar = entriesById.get(rivalry.entryIds[0])?.carName || "one car";
    const secondCar = entriesById.get(rivalry.entryIds[1])?.carName || "another car";
    const oneSidedWinner = oneSidedRivalry && oneSidedRivalry[1] > rivalry.count / 2
      ? entriesById.get(oneSidedRivalry[0])?.carName
      : null;
    paragraphTwoCandidates.push({
      priority: oneSidedWinner ? 70 : 50,
      text: oneSidedWinner
        ? recapChoice([
          `${firstCar} and ${secondCar} kept meeting in traffic, but ${oneSidedWinner} won most of the arguments, taking ${oneSidedRivalry[1]} of their ${rivalry.count} confrontations.`,
          `${oneSidedWinner} got the better of the duel between ${firstCar} and ${secondCar}, dictating the terms in ${oneSidedRivalry[1]} of ${rivalry.count} exchanges.`,
          `The rivalry between ${firstCar} and ${secondCar} was not exactly equal: ${oneSidedWinner} kept finding the sharper line.`,
        ], `${keyPrefix}:one-sided-rivalry`)
        : recapChoice([
          `${firstCar} and ${secondCar} kept finding each other, producing ${rivalry.count} overtake confrontations and trading paint more than once.`,
          `${firstCar} and ${secondCar} spent the day in each other's air, stacking up ${rivalry.count} overtake confrontations.`,
          `Traffic kept braiding ${firstCar} together with ${secondCar}, giving the crowd ${rivalry.count} separate passing arguments to judge.`,
          `${firstCar} and ${secondCar} turned the race into a rolling disagreement, meeting ${rivalry.count} times in overtake traffic.`,
        ], `${keyPrefix}:rivalry`),
    });
  }
  if (cleanContender) {
    const entry = entriesById.get(cleanContender.id);
    paragraphTwoCandidates.push({
      priority: 45,
      text: recapChoice([
        `${entry.carName} kept it clean all race, finishing P${cleanContender.position} without a reported mishap or spin.`,
        `While the field found trouble, ${entry.carName} stayed tidy, bringing home P${cleanContender.position} with no recorded incidents.`,
        `${entry.carName} made restraint look fast, avoiding the mess entirely on the way to P${cleanContender.position}.`,
      ], `${keyPrefix}:clean-contender`),
    });
  }
  if (messyResult) {
    paragraphTwoCandidates.push({
      priority: messyResult.standing.position <= 3 ? 80 : 55,
      text: recapChoice([
        `${messyResult.incidents.carName} had no business surviving that gracefully, collecting ${messyResult.total} incidents and still finishing P${messyResult.standing.position}.`,
        `Despite ${messyResult.total} recorded incidents, ${messyResult.incidents.carName} dragged itself to P${messyResult.standing.position}, smoking, wobbling, and somehow still worthy.`,
        `${messyResult.incidents.carName} treated disaster like a co-driver, enduring ${messyResult.total} incidents and still reaching P${messyResult.standing.position}.`,
        `${messyResult.incidents.carName} spent the race arguing with physics, taking ${messyResult.total} incidents and still landing P${messyResult.standing.position}.`,
        `${messyResult.incidents.carName} kept finding trouble and refusing to stay found, surviving ${messyResult.total} incidents for a P${messyResult.standing.position} finish.`,
        `${incidentLeader.carName} had the messiest run, collecting ${incidentLeader.count} reported mishaps (${incidentLeader.cornerMishaps} from turns and chicanes, and ${incidentLeader.overtakeMishaps} from failed overtakes).`,
      ], `${keyPrefix}:messy-result:${messyResult.incidents.carName}:${messyResult.total}:${messyResult.standing.position}`),
    });
  } else if (incidentLeader && incidentLeader.count + incidentLeader.spins === 1) {
    paragraphTwoCandidates.push({
      priority: 25,
      text: `${incidentLeader.carName} supplied one of the sharper mishaps, a stark reminder that the Speed God waits for no one.`,
    });
  }
  if (strangeEvents.length) {
    const bad = strangeEvents.filter((event) => event.tone === "bad").length;
    const good = strangeEvents.filter((event) => event.tone === "good").length;
    paragraphTwoCandidates.push({
      priority: 60,
      text: recapChoice([
        `The weird-shit-o-meter recorded ${strangeEvents.length} strange effect${strangeEvents.length === 1 ? "" : "s"}: ${good} blessed, ${bad} cursed.`,
        strangeDriver
          ? `The Stewards, their radiance emanating, marked ${strangeDriver} as the driver most tangled in the extraplanar business of speed and drag.`
          : `The weird-shit-o-meter recorded ${strangeEvents.length} strange effect${strangeEvents.length === 1 ? "" : "s"}: ${good} blessed, ${bad} cursed.`,
        strangeDriver
          ? `${strangeDriver} drew the strangest attention of the day, becoming a temporary argument between Velocitus and The Decelerator.`
          : `The strange ledger ended at ${good} blessed and ${bad} cursed, which is not balance so much as accounting with teeth.`,
        `Reality made ${strangeEvents.length} unscheduled contribution${strangeEvents.length === 1 ? "" : "s"} to the race, leaving ${good} blessing${good === 1 ? "" : "s"} and ${bad} curse${bad === 1 ? "" : "s"} in its wake.`,
      ], `${keyPrefix}:strange:${strangeDriver || "field"}:${good}:${bad}:${strangeEvents.length}`),
    });
  }
  if (positiveChurnDrivers.length) {
    paragraphTwoCandidates.push({ priority: 65, text: recapChoice([
      `${recapList(positiveChurnDrivers)} had a blessed and divine Churning visited upon them, surely a sign of their piety and gracefulness before Velocitus.`,
      `With the heavens billowing and shredded, ${recapList(positiveChurnDrivers)} ${positiveChurnDrivers.length === 1 ? "was" : "were"} graced by The Speed God, being granted truly divine boons before the race concluded.`,
      `The Churning opened one bright eye for ${recapList(positiveChurnDrivers)}, and for once the gaze was merciful.`,
    ], `${keyPrefix}:positive-churn`) });
  }
  if (negativeChurnDrivers.length) {
    paragraphTwoCandidates.push({ priority: 75, text: recapChoice([
      `But The Churning is fickle, and ${recapList(negativeChurnDrivers)} suffered at the hands of The Decelerator, bringing shame to ${recapList(negativeChurnTeams)}.`,
      `Lo, The Churning spit out vile curses upon ${recapList(negativeChurnDrivers)}. Does The Decelerator live within their hearts?`,
      `The Churning did not simply watch ${recapList(negativeChurnDrivers)}; it reached down, adjusted the terms, and left the bill with ${recapList(negativeChurnTeams)}.`,
    ], `${keyPrefix}:negative-churn`) });
  }
  if (dnfEntries.length) {
    const dnfCars = dnfEntries.map((standing) => entriesById.get(standing.id)?.carName || standing.id);
    paragraphTwoCandidates.push({ priority: 85, text: recapChoice([
      `${recapList(dnfCars)} failed to finish, leaving the points table with a razor-sharp edge.`,
      `${recapList(dnfCars)} succumbed to the will of The Decelerator, DNFing before they could cross the finish line.`,
      `${recapList(dnfCars)} never saw the flag, their day ending in the cold arithmetic of DNF.`,
    ], `${keyPrefix}:dnf`) });
  }
  if (rookieDebuts.length && veteranSeasonDebuts.length) {
    paragraphTwoCandidates.push({ priority: 1000, text: recapChoice([
      `Today's field mixed old ghosts and new prayers: ${recapList(veteranSeasonDebuts)} made their season debuts, while ${recapList(rookieDebuts)} took their first ASSCAR60 laps.`,
      `The race welcomed both returning hands and fresh sacrifices, as ${recapList(veteranSeasonDebuts)} returned for the season and ${recapList(rookieDebuts)} debuted in league competition.`,
      `Experience and innocence shared the grid today: ${recapList(veteranSeasonDebuts)} appeared for the first time this season, while ${recapList(rookieDebuts)} began their ASSCAR60 careers.`,
    ], `${keyPrefix}:mixed-debuts`) });
  } else if (rookieDebuts.length === 1) {
    paragraphTwoCandidates.push({ priority: 1000, text: recapChoice([
      `${rookieDebuts[0]} made their ASSCAR60 debut, taking their first official laps while The Stewards watched with unknowable interest.`,
      `${rookieDebuts[0]} entered the league record for the first time today, a rookie baptism by speed, smoke, and questionable judgment.`,
      `${rookieDebuts[0]} ran their first ASSCAR60 race, beginning what may become a glorious career or a cautionary pamphlet.`,
    ], `${keyPrefix}:single-rookie-debut`) });
  } else if (rookieDebuts.length > 1) {
    paragraphTwoCandidates.push({ priority: 1000, text: recapChoice([
      `The rookie ranks expanded today, as ${recapList(rookieDebuts)} made their ASSCAR60 debuts and learned how loud the black top can be.`,
      `${recapList(rookieDebuts)} all entered official league competition for the first time, fresh names thrown directly into the machinery of speed.`,
      `A new class of hopefuls arrived on track today, with ${recapList(rookieDebuts)} making their first ASSCAR60 starts.`,
    ], `${keyPrefix}:multi-rookie-debut`) });
  } else if (veteranSeasonDebuts.length === 1) {
    paragraphTwoCandidates.push({ priority: 1000, text: recapChoice([
      `${veteranSeasonDebuts[0]} returned to ASSCAR60 competition for the first time this season, bringing old scars and fresh intentions back onto the black top.`,
      `${veteranSeasonDebuts[0]} made their season debut, a familiar name reappearing under the lights with something still to prove.`,
      `${veteranSeasonDebuts[0]} was back in the car for the first time this season, and the league was reminded that experience does not always arrive quietly.`,
    ], `${keyPrefix}:single-veteran-season-debut`) });
  } else if (veteranSeasonDebuts.length > 1) {
    paragraphTwoCandidates.push({ priority: 1000, text: recapChoice([
      `Several veterans made their first appearances of the season, with ${recapList(veteranSeasonDebuts)} returning to race action after watching the early weeks from the margins.`,
      `${recapList(veteranSeasonDebuts)} all made their season debuts, bringing a little old road memory back into the field.`,
      `The grid saw the return of proven hands today, as ${recapList(veteranSeasonDebuts)} each took their first laps of the season.`,
    ], `${keyPrefix}:multi-veteran-season-debut`) });
  }
  if (teamTopSix) {
    const positions = teamTopSix.cars
      .map((car) => `P${car.standing.position}`)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    paragraphTwoCandidates.push({ priority: 40, text: recapChoice([
      `${teamTopSix.teamName} put both cars in the top six, finishing ${positions.join(" and ")} for the strongest two-car showing of the day.`,
      `${teamTopSix.teamName} doubled up near the front, with both cars landing P6 or better and dragging home a heavy points haul.`,
      `No garage looked more complete than ${teamTopSix.teamName}, whose two cars finished ${positions.join(" and ")} to anchor the sharpest team result of the race.`,
    ], `${keyPrefix}:team-top-six`) });
  }
  if (teamDisaster) {
    const dnfCar = teamDisaster.cars.find((car) => car.standing.status === "dnf");
    paragraphTwoCandidates.push({ priority: 45, text: recapChoice([
      `${teamDisaster.teamName} had a rough one, with both cars finishing outside the points.`,
      `The day did not smile on ${teamDisaster.teamName}, whose two cars both came home empty-handed.`,
      dnfCar
        ? `${teamDisaster.teamName} came home empty-handed, with ${dnfCar.entry.carName} failing to finish and the other car outside the points.`
        : `${teamDisaster.teamName} leaves this one with questions, prayers, and no points from either car.`,
    ], `${keyPrefix}:team-disaster`) });
  }
  if (streak) {
    const entry = entriesById.get(streak.entryId);
    if (entry) {
      paragraphTwoCandidates.push({ priority: 35, text: streak.topHalf
        ? recapChoice([
          `${entry.carName} kept its top-half streak alive, now ${streak.count} races without finishing below 6th.`,
          `${entry.carName} has become stubbornly difficult to bury, extending its streak of P6-or-better finishes to ${streak.count}.`,
          `The Stewards note consistency: ${entry.carName} has now gone ${streak.count} straight races without falling below 6th.`,
        ], `${keyPrefix}:top-streak`)
        : recapChoice([
          `${entry.carName} remains trapped below the cutline, now ${streak.count} races without finishing above 6th.`,
          `${entry.carName} could not break the pattern, extending its streak of P7-or-worse finishes to ${streak.count}.`,
          `The standings remain unkind to ${entry.carName}, which has now gone ${streak.count} races without cracking the top six.`,
        ], `${keyPrefix}:bottom-streak`) });
    }
  }
  const paragraphTwoParts = paragraphTwoCandidates
    .sort((a, b) => b.priority - a.priority || hashText(`${keyPrefix}:${a.text}`) - hashText(`${keyPrefix}:${b.text}`))
    .slice(0, 3)
    .map((candidate) => candidate.text);
  if (!paragraphTwoParts.length) {
    paragraphTwoParts.push("There were no single monolithic turning points, just pressure accumulating through lap time, traffic, and the usual sacred flow of speed.");
  }

  return `${paragraphOneParts.join(" ")}\n\n${paragraphTwoParts.join(" ")}`;
}

function calculateSeasonChampionships(raceRows) {
  const teamRecords = new Map(teams.map((team) => [team.id, {
    teamId: team.id,
    pointUnits: 0,
    finishCounts: Array(RACE_POINTS.length).fill(0),
    races: 0,
    sortName: team.name,
  }]));
  const mvdRecords = new Map();

  for (const raceRow of raceRows) {
    const entries = JSON.parse(raceRow.entries_json);
    const standings = JSON.parse(raceRow.standings_json);
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    for (const standing of standings) {
      const entry = entryById.get(standing.id);
      if (!entry) continue;
      const positionIndex = standing.position - 1;
      const carPoints = standing.status === "dnf" ? 0 : RACE_POINTS[positionIndex] ?? 0;
      const teamRecord = teamRecords.get(entry.teamId);
      teamRecord.pointUnits += carPoints * TOTAL_LAPS;
      if (standing.status !== "dnf") teamRecord.finishCounts[positionIndex] += 1;
      teamRecord.races += 1;

      for (const [stintIndex, stint] of entry.stints.entries()) {
        const racerId = stint.driver.id;
        const stintLaps = stint.end - stint.start + 1;
        const record = mvdRecords.get(racerId) || {
          racerId,
          racerName: stint.driver.name,
          teamId: entry.teamId,
          pointUnits: 0,
          finishCounts: Array(RACE_POINTS.length).fill(0),
          races: 0,
          sortName: stint.driver.name,
        };
        record.pointUnits += carPoints * stintLaps;
        if (standing.status !== "dnf" && stintIndex === 0) {
          record.pointUnits += MVD_OPENER_BONUS_UNITS;
        }
        if (standing.status !== "dnf" && stintIndex === entry.stints.length - 1) {
          record.pointUnits += MVD_CLOSER_BONUS_UNITS;
        }
        if (standing.status !== "dnf") record.finishCounts[positionIndex] += 1;
        record.races += 1;
        record.teamId = entry.teamId;
        mvdRecords.set(racerId, record);
      }
    }
  }

  return {
    teams: rankChampionshipRecords([...teamRecords.values()]),
    mvds: rankChampionshipRecords([...mvdRecords.values()]),
  };
}

function calculateTeamChampionshipWins(raceRows) {
  const racesBySeason = new Map();
  for (const raceRow of raceRows) {
    const seasonRaces = racesBySeason.get(raceRow.season) || [];
    seasonRaces.push(raceRow);
    racesBySeason.set(raceRow.season, seasonRaces);
  }
  const wins = Object.fromEntries(teams.map((team) => [team.id, 0]));
  for (const seasonRaces of racesBySeason.values()) {
    if (seasonRaces.length < SEASON_RACES) continue;
    for (const standing of calculateSeasonChampionships(seasonRaces).teams) {
      if (standing.rank !== 1) break;
      wins[standing.teamId] += 1;
    }
  }
  return wins;
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pronounsForRacer(identity) {
  const roll = hashText(`pronouns:${identity}`) % 100;
  if (roll < 35) return PRONOUNS[0];
  if (roll < 70) return PRONOUNS[1];
  if (roll < 90) return PRONOUNS[2];
  return PRONOUNS[3];
}

function snakeTeamId(pickIndex, order = teams.map((team) => team.id)) {
  const roundIndex = Math.floor(pickIndex / teams.length);
  const position = pickIndex % teams.length;
  const teamIndex = roundIndex % 2 === 0 ? position : teams.length - 1 - position;
  return order[teamIndex];
}

function validatePlan(team, roster, plan) {
  if (!plan || !Array.isArray(plan.lineup) || plan.lineup.length !== 6) {
    throw new Error("A relay plan must contain six stint assignments.");
  }
  if (!Array.isArray(plan.carNames) || plan.carNames.length !== 2) {
    throw new Error("A team must have two car names.");
  }

  const validDriverIds = new Set(roster.map((driver) => driver.id));
  const lineup = plan.lineup.map((assignment) => ({
    driverId: String(assignment.driverId),
    laps: Number(assignment.laps),
  }));
  const carNames = plan.carNames.map((name) => String(name).trim());

  if (lineup.some((assignment) => !validDriverIds.has(assignment.driverId))) {
    throw new Error("A relay assignment contains a racer outside this team.");
  }
  if (lineup.some((assignment) => !Number.isInteger(assignment.laps)
    || assignment.laps < 5 || assignment.laps > 40)) {
    throw new Error("Every stint must be between 5 and 40 whole laps.");
  }

  for (let carIndex = 0; carIndex < 2; carIndex += 1) {
    const assignments = lineup.slice(carIndex * 3, carIndex * 3 + 3);
    if (assignments.reduce((sum, assignment) => sum + assignment.laps, 0) !== 60) {
      throw new Error("Each car's stints must total exactly 60 laps.");
    }
  }
  if (new Set(lineup.map((assignment) => assignment.driverId)).size !== 6) {
    throw new Error("A racer can only appear once across a team's two relay plans.");
  }

  if (carNames.some((name) => !name || name.length > 32)) {
    throw new Error("Each car needs a name of 1 to 32 characters.");
  }
  if (new Set(carNames.map((name) => name.toLocaleLowerCase())).size !== 2) {
    throw new Error("A team's two cars need different names.");
  }

  return { lineup, carNames };
}

function qualifierMishapPenalty(severity, random) {
  return severity <= 3
    ? 2 + Math.floor(random() * 2)
    : 3 + Math.floor(random() * 2);
}

function qualifierWeatherMishapFactor(condition) {
  if (condition === "Raining") return 0.9;
  if (condition === "Snowing") return 0.7;
  return 1;
}

function qualifierCornerMishapChance(denominator) {
  return (1 / Math.max(1, denominator)) * (2 / 3);
}

function qualifierLapResult(entry, driver, course, condition, random) {
  const baseTime = basePartDuration(course.length, driver.pace, entry.vehicle.speed);
  const segmentTime = course.segments
    .filter((segment) => segment.type === "turn" || segment.type === "chicane")
    .reduce((total, segment) => (
      total
      + Math.max(0, segment.severity * 0.5 - driver.control * 0.03 - entry.vehicle.handling * 0.02)
    ), 0);
  const incidents = [];
  let incidentTime = 0;
  for (const segment of course.segments.filter((item) => item.type === "turn" || item.type === "chicane")) {
    const denominator = qualifierWeatherMishapFactor(condition)
      * (5 + driver.control + entry.vehicle.handling - segment.severity);
    if (random() < qualifierCornerMishapChance(denominator)) {
      const penalty = qualifierMishapPenalty(segment.severity, random);
      incidentTime += penalty;
      incidents.push({
        type: "mishap",
        driver: driver.name,
        segmentType: segment.type,
        severity: segment.severity,
        penalty,
      });
      if (random() < 1 / 800) {
        incidentTime += 10;
        incidents.push({
          type: "spin",
          driver: driver.name,
          segmentType: segment.type,
          severity: segment.severity,
          penalty: 10,
        });
      }
    }
  }
  return {
    driver: driver.name,
    cleanTime: baseTime + segmentTime,
    incidentTime,
    totalTime: baseTime + segmentTime + incidentTime,
    incidents,
  };
}

function applyQualifierGrid(entries, standings, courseName, condition = "Sunny", seed = "qualifier") {
  const course = COURSES.find((item) => item.name === courseName) || COURSES[0];
  const random = seededRandom(hashText(`${seed}:${courseName}:${condition}:qualifier`));
  const standingOrder = standings.length
    ? standings.map((standing) => standing.teamId)
    : teams.map((team) => team.id);
  const orderIndex = new Map(standingOrder.map((teamId, index) => [teamId, index]));
  const qualificationOrder = [...entries].sort((a, b) => (
    (orderIndex.get(a.teamId) ?? Number.MAX_SAFE_INTEGER)
    - (orderIndex.get(b.teamId) ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id)
  ));
  const results = qualificationOrder.map((entry, qualificationIndex) => {
    const drivers = entry.stints.slice(0, 3).map((stint) => stint.driver);
    const lapResults = drivers.map((driver) => qualifierLapResult(
      entry,
      driver,
      course,
      condition,
      random,
    ));
    const lapTimes = lapResults.map((result) => result.totalTime);
    return {
      entryId: entry.id,
      carName: entry.carName,
      teamId: entry.teamId,
      qualificationOrder: qualificationIndex + 1,
      drivers: drivers.map((driver) => driver.name),
      lapTimes,
      lapResults,
      incidents: lapResults.flatMap((result, lapIndex) => result.incidents.map((incident) => ({
        ...incident,
        lap: lapIndex + 1,
      }))),
      totalTime: lapTimes.reduce((total, lapTime) => total + lapTime, 0),
    };
  }).sort((a, b) => a.totalTime - b.totalTime || a.qualificationOrder - b.qualificationOrder);
  const resultByEntry = new Map(results.map((result, index) => [result.entryId, {
    ...result,
    gridPosition: index + 1,
    firstLapPenalty: index * 0.2,
  }]));
  return entries.map((entry) => {
    const qualifier = resultByEntry.get(entry.id);
    return {
      ...entry,
      qualifier,
      startingGridPosition: qualifier.gridPosition,
      startingGridPenalty: qualifier.firstLapPenalty,
    };
  });
}

export function createLeagueStore(path = ":memory:") {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS managers (
      username TEXT PRIMARY KEY,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      team_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS manager_sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES managers(username) ON DELETE CASCADE,
      team_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS team_plans (
      team_id TEXT PRIMARY KEY,
      car_one_name TEXT NOT NULL,
      car_two_name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS team_brands (
      team_id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      abbreviation TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL UNIQUE,
      name_changed_season INTEGER,
      abbreviation_changed_season INTEGER,
      color_changed_season INTEGER,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS relay_stints (
      team_id TEXT NOT NULL REFERENCES team_plans(team_id) ON DELETE CASCADE,
      car_index INTEGER NOT NULL CHECK (car_index BETWEEN 0 AND 1),
      stint_index INTEGER NOT NULL CHECK (stint_index BETWEEN 0 AND 2),
      driver_id TEXT NOT NULL,
      laps INTEGER NOT NULL CHECK (laps BETWEEN 5 AND 40),
      PRIMARY KEY (team_id, car_index, stint_index)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cars (
      team_id TEXT NOT NULL REFERENCES team_plans(team_id) ON DELETE CASCADE,
      car_index INTEGER NOT NULL CHECK (car_index BETWEEN 0 AND 1),
      speed INTEGER NOT NULL CHECK (speed BETWEEN 1 AND 10),
      handling INTEGER NOT NULL CHECK (handling BETWEEN 1 AND 10),
      durability INTEGER NOT NULL CHECK (durability BETWEEN 1 AND 10),
      feedback INTEGER NOT NULL CHECK (feedback BETWEEN 1 AND 10),
      weird INTEGER NOT NULL CHECK (weird BETWEEN 1 AND 10),
      PRIMARY KEY (team_id, car_index)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS racers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      pace INTEGER NOT NULL,
      control INTEGER NOT NULL,
      overtaking INTEGER NOT NULL,
      stamina INTEGER NOT NULL,
      technical INTEGER NOT NULL,
      weird INTEGER NOT NULL,
      speed_mark INTEGER NOT NULL DEFAULT 0 CHECK (speed_mark IN (0, 1)),
      potential INTEGER NOT NULL,
      note TEXT NOT NULL,
      pronouns TEXT NOT NULL,
      team_id TEXT,
      source TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS draft_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      pool_size INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS draft_picks (
      pick_number INTEGER PRIMARY KEY,
      round_number INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      racer_id TEXT NOT NULL UNIQUE REFERENCES racers(id),
      picked_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS draft_initiation_votes (
      season INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      voted_at TEXT NOT NULL,
      PRIMARY KEY (season, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS initiation_martyr_state (
      season INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('voting', 'resolved')),
      racer_id TEXT REFERENCES racers(id),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS initiation_martyr_votes (
      season INTEGER NOT NULL REFERENCES initiation_martyr_state(season) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      racer_id TEXT NOT NULL REFERENCES racers(id),
      voted_at TEXT NOT NULL,
      PRIMARY KEY (season, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rookie_draft_state (
      season INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('voting', 'active', 'releases', 'complete')),
      seed INTEGER NOT NULL,
      order_json TEXT NOT NULL,
      current_pick INTEGER NOT NULL DEFAULT 1,
      pick_deadline TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rookie_draft_picks (
      season INTEGER NOT NULL REFERENCES rookie_draft_state(season) ON DELETE CASCADE,
      pick_number INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      racer_id TEXT NOT NULL REFERENCES racers(id),
      automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1)),
      picked_at TEXT NOT NULL,
      PRIMARY KEY (season, pick_number),
      UNIQUE (season, racer_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rookie_draft_initiation_votes (
      season INTEGER NOT NULL REFERENCES rookie_draft_state(season) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      voted_at TEXT NOT NULL,
      PRIMARY KEY (season, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rookie_draft_releases (
      season INTEGER NOT NULL REFERENCES rookie_draft_state(season) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      racer_id TEXT NOT NULL REFERENCES racers(id),
      released_at TEXT NOT NULL,
      PRIMARY KEY (season, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS trade_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offering_team_id TEXT NOT NULL,
      receiving_team_id TEXT NOT NULL,
      offered_racer_id TEXT NOT NULL REFERENCES racers(id),
      requested_racer_id TEXT NOT NULL REFERENCES racers(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS trade_alert_reads (
      username TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (username, alert_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS draft_vote_alert_reads (
      username TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (username, alert_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS media_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author_username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS media_entry_reads (
      username TEXT NOT NULL,
      media_entry_id INTEGER NOT NULL REFERENCES media_entries(id) ON DELETE CASCADE,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (username, media_entry_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      team_id TEXT NOT NULL,
      other_team_id TEXT,
      acquired_racer_id TEXT REFERENCES racers(id),
      moved_racer_id TEXT REFERENCES racers(id),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS racer_growth (
      racer_id TEXT NOT NULL REFERENCES racers(id) ON DELETE CASCADE,
      stat TEXT NOT NULL,
      remaining INTEGER NOT NULL CHECK (remaining >= 0),
      discovered_cap INTEGER NOT NULL DEFAULT 0 CHECK (discovered_cap IN (0, 1)),
      PRIMARY KEY (racer_id, stat)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS weekly_upgrade_weeks (
      week INTEGER PRIMARY KEY,
      option_one TEXT NOT NULL,
      option_two TEXT NOT NULL,
      option_three TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS weekly_upgrade_choices (
      week INTEGER NOT NULL REFERENCES weekly_upgrade_weeks(week),
      team_id TEXT NOT NULL,
      option_index INTEGER NOT NULL CHECK (option_index BETWEEN 0 AND 2),
      racer_id TEXT NOT NULL REFERENCES racers(id),
      stat TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('improved', 'capped')),
      created_at TEXT NOT NULL,
      applied_at TEXT,
      PRIMARY KEY (week, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS weekly_car_upgrade_weeks (
      week INTEGER PRIMARY KEY,
      option_one TEXT NOT NULL,
      option_two TEXT NOT NULL,
      option_three TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS weekly_car_upgrade_choices (
      week INTEGER NOT NULL REFERENCES weekly_car_upgrade_weeks(week),
      team_id TEXT NOT NULL,
      option_index INTEGER NOT NULL CHECK (option_index BETWEEN 0 AND 2),
      car_index INTEGER NOT NULL CHECK (car_index BETWEEN 0 AND 1),
      stat TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      PRIMARY KEY (week, team_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS weekly_race_participation (
      week INTEGER NOT NULL,
      racer_id TEXT NOT NULL REFERENCES racers(id),
      team_id TEXT NOT NULL,
      first_used_at TEXT NOT NULL,
      PRIMARY KEY (week, racer_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS races (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      race_number INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      seed TEXT NOT NULL,
      duration REAL NOT NULL,
      entries_json TEXT NOT NULL,
      events_json TEXT NOT NULL,
      standings_json TEXT NOT NULL,
      recap_text TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (season, week, race_number)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS race_results (
      race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      car_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      points INTEGER NOT NULL,
      PRIMARY KEY (race_id, entry_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS race_laps (
      race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      race_number INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      car_name TEXT NOT NULL,
      racer_id TEXT NOT NULL REFERENCES racers(id),
      racer_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Opener', 'Bridge', 'Closer')),
      lap INTEGER NOT NULL CHECK (lap BETWEEN 1 AND 60),
      lap_time REAL NOT NULL,
      PRIMARY KEY (race_id, entry_id, lap)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS season_history (
      season INTEGER PRIMARY KEY,
      team_standings_json TEXT NOT NULL,
      mvd_standings_json TEXT NOT NULL,
      champions_json TEXT NOT NULL,
      opening_draft_json TEXT,
      rookie_draft_json TEXT,
      finalized_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS league_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_race_id INTEGER REFERENCES races(id),
      active_season INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    ) STRICT;

  `);

  const managerColumns = database.prepare("PRAGMA table_info(managers)").all();
  if (!managerColumns.some((column) => column.name === "team_id")) {
    database.exec("ALTER TABLE managers ADD COLUMN team_id TEXT");
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS manager_team_unique
    ON managers(team_id)
    WHERE team_id IS NOT NULL;
  `);

  const runtimeColumns = database.prepare("PRAGMA table_info(league_runtime)").all();
  if (!runtimeColumns.some((column) => column.name === "active_season")) {
    database.exec("ALTER TABLE league_runtime ADD COLUMN active_season INTEGER NOT NULL DEFAULT 1");
  }
  const seasonHistoryColumns = database.prepare("PRAGMA table_info(season_history)").all();
  if (!seasonHistoryColumns.some((column) => column.name === "opening_draft_json")) {
    database.exec("ALTER TABLE season_history ADD COLUMN opening_draft_json TEXT");
  }
  if (!seasonHistoryColumns.some((column) => column.name === "rookie_draft_json")) {
    database.exec("ALTER TABLE season_history ADD COLUMN rookie_draft_json TEXT");
  }
  const draftInitiationVoteColumns = database.prepare("PRAGMA table_info(draft_initiation_votes)").all();
  if (!draftInitiationVoteColumns.some((column) => column.name === "veteran_retention_id")) {
    database.exec("ALTER TABLE draft_initiation_votes ADD COLUMN veteran_retention_id TEXT");
  }
  if (!draftInitiationVoteColumns.some((column) => column.name === "rookie_retention_id")) {
    database.exec("ALTER TABLE draft_initiation_votes ADD COLUMN rookie_retention_id TEXT");
  }
  const rookieDraftStateTable = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rookie_draft_state'
  `).get();
  if (rookieDraftStateTable?.sql && !rookieDraftStateTable.sql.includes("'voting'")) {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE rookie_draft_state_new (
        season INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('voting', 'active', 'releases', 'complete')),
        seed INTEGER NOT NULL,
        order_json TEXT NOT NULL,
        current_pick INTEGER NOT NULL DEFAULT 1,
        pick_deadline TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      INSERT INTO rookie_draft_state_new (
        season, status, seed, order_json, current_pick, pick_deadline, started_at, completed_at
      )
      SELECT season, status, seed, order_json, current_pick, pick_deadline, started_at, completed_at
      FROM rookie_draft_state;
      DROP TABLE rookie_draft_state;
      ALTER TABLE rookie_draft_state_new RENAME TO rookie_draft_state;
      PRAGMA foreign_keys = ON;
    `);
  }
  const raceColumns = database.prepare("PRAGMA table_info(races)").all();
  if (!raceColumns.some((column) => column.name === "start_at")) {
    database.exec("ALTER TABLE races ADD COLUMN start_at TEXT");
    database.exec("UPDATE races SET start_at = created_at WHERE start_at IS NULL");
  }
  if (!raceColumns.some((column) => column.name === "recap_text")) {
    database.exec("ALTER TABLE races ADD COLUMN recap_text TEXT");
  }
  const weeklyChoiceColumns = database.prepare("PRAGMA table_info(weekly_upgrade_choices)").all();
  if (!weeklyChoiceColumns.some((column) => column.name === "applied_at")) {
    database.exec("ALTER TABLE weekly_upgrade_choices ADD COLUMN applied_at TEXT");
    database.exec("UPDATE weekly_upgrade_choices SET applied_at = created_at WHERE applied_at IS NULL");
  }
  const weeklyCarChoiceColumns = database.prepare("PRAGMA table_info(weekly_car_upgrade_choices)").all();
  if (!weeklyCarChoiceColumns.some((column) => column.name === "applied_at")) {
    database.exec("ALTER TABLE weekly_car_upgrade_choices ADD COLUMN applied_at TEXT");
    database.exec("UPDATE weekly_car_upgrade_choices SET applied_at = created_at WHERE applied_at IS NULL");
  }
  database.exec(`
    INSERT OR IGNORE INTO league_runtime (id, active_race_id, active_season, updated_at)
    VALUES (1, NULL, 1, 'initial')
  `);
  let racerColumns = database.prepare("PRAGMA table_info(racers)").all();
  if (racerColumns.some((column) => column.name === "strangeness")
    && !racerColumns.some((column) => column.name === "weird")) {
    database.exec("ALTER TABLE racers RENAME COLUMN strangeness TO weird");
    database.exec("UPDATE racer_growth SET stat = 'weird' WHERE stat = 'strangeness'");
    database.exec("UPDATE weekly_upgrade_weeks SET option_one = 'weird' WHERE option_one = 'strangeness'");
    database.exec("UPDATE weekly_upgrade_weeks SET option_two = 'weird' WHERE option_two = 'strangeness'");
    database.exec("UPDATE weekly_upgrade_weeks SET option_three = 'weird' WHERE option_three = 'strangeness'");
    database.exec("UPDATE weekly_upgrade_choices SET stat = 'weird' WHERE stat = 'strangeness'");
    racerColumns = database.prepare("PRAGMA table_info(racers)").all();
  }
  if (!racerColumns.some((column) => column.name === "pronouns")) {
    database.exec("ALTER TABLE racers ADD COLUMN pronouns TEXT");
    const readRacersForPronouns = database.prepare("SELECT id FROM racers");
    const setRacerPronouns = database.prepare("UPDATE racers SET pronouns = ? WHERE id = ?");
    for (const racer of readRacersForPronouns.all()) {
      setRacerPronouns.run(pronounsForRacer(racer.id), racer.id);
    }
  }
  if (!racerColumns.some((column) => column.name === "speed_mark")) {
    database.exec("ALTER TABLE racers ADD COLUMN speed_mark INTEGER NOT NULL DEFAULT 0");
  }
  database.exec(`
    UPDATE races SET course_name = CASE course_name
      WHEN 'The Glass Orchard' THEN 'Race City'
      WHEN 'The Submerged Parliament' THEN 'New Torque City'
      WHEN 'Saint Velocity''s Spiral' THEN 'Acceleton'
      WHEN 'The Lunar Service Road' THEN 'Suzuka'
      ELSE course_name
    END
  `);
  database.exec(`
    UPDATE racers
    SET potential = 5
    WHERE potential > 5 AND source NOT LIKE 'rookie-%'
  `);

  const insertTeam = database.prepare(`
    INSERT OR IGNORE INTO team_plans (
      team_id, car_one_name, car_two_name, updated_at
    ) VALUES (?, ?, ?, ?)
  `);
  const insertBrand = database.prepare(`
    INSERT OR IGNORE INTO team_brands (
      team_id, name, abbreviation, color, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertStint = database.prepare(`
    INSERT OR IGNORE INTO relay_stints (
      team_id, car_index, stint_index, driver_id, laps
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertCar = database.prepare(`
    INSERT OR IGNORE INTO cars (
      team_id, car_index, speed, handling, durability, feedback, weird
    ) VALUES (?, ?, 3, 3, 3, 3, 3)
  `);
  const insertRacer = database.prepare(`
    INSERT OR IGNORE INTO racers (
      id, name, pace, control, overtaking, stamina, technical,
      weird, potential, note, pronouns, team_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countRacers = database.prepare("SELECT COUNT(1) AS count FROM racers");
  const reactivateGeneratedRacer = database.prepare(`
    UPDATE racers
    SET name = ?, pace = ?, control = ?, overtaking = ?, stamina = ?,
        technical = ?, weird = ?, speed_mark = 0, potential = ?,
        note = ?, pronouns = ?, team_id = ?, source = ?
    WHERE id = ? AND team_id IS NULL
  `);

  function seedOpeningDraftPool(seed = randomBytes(4).readUInt32BE(0)) {
    const random = seededRandom(seed);
    const names = generateRacerNames(60, seed, readAllRacerNamesSafe(database));
    const notes = [
      "Keeps a spare horizon in the glovebox.",
      "Has never lost an argument with a hairpin.",
      "Claims the racing line appeared in a dream.",
      "Can identify engines by their favorite weather.",
      "Carries an emergency duplicate of the moon.",
      "Refuses to acknowledge conventional braking zones.",
    ];
    names.forEach((name, index) => {
      const rating = () => 4 + Math.floor(random() * 6);
      const racerId = `opening-draft-${seed}-${index + 1}`;
      insertRacer.run(
        racerId,
        name,
        rating(),
        rating(),
        rating(),
        rating(),
        rating(),
        rating(),
        1 + Math.floor(random() * 5),
        notes[Math.floor(random() * notes.length)],
        pronounsForRacer(racerId),
        null,
        "draft",
      );
    });
  }

  database.exec("BEGIN");
  try {
    for (const team of teams) {
      insertBrand.run(team.id, team.name, team.short, team.color, new Date().toISOString());
      const carNames = defaultCarNames(team);
      insertTeam.run(team.id, carNames[0], carNames[1], new Date().toISOString());
      insertCar.run(team.id, 0);
      insertCar.run(team.id, 1);
      defaultLineup(team).forEach((assignment, slot) => {
        insertStint.run(
          team.id,
          Math.floor(slot / 3),
          slot % 3,
          assignment.driverId,
          assignment.laps,
        );
      });
    }
    if (countRacers.get().count === 0) seedOpeningDraftPool();
    if (false) {
    const existingNames = readAllRacerNamesSafe(database);
    const freeAgentNames = generateRacerNames(12, 606060, existingNames);
    const freeAgentRandom = seededRandom(606060);
    freeAgentNames.forEach((name, index) => {
      const rating = () => 4 + Math.floor(freeAgentRandom() * 6);
      insertRacer.run(
        `free-agent-${index + 1}`,
        name,
        rating(),
        rating(),
        rating(),
        rating(),
        rating(),
        rating(),
        1 + Math.floor(freeAgentRandom() * 5),
        "Waiting beside the paddock with a helmet and a complicated résumé.",
        pronounsForRacer(`free-agent-${index + 1}`),
        null,
        "draft",
      );
    });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const seededBrands = database.prepare(
    "SELECT team_id, color, color_changed_season FROM team_brands ORDER BY rowid",
  ).all();
  const setSeededBrandColor = database.prepare(
    "UPDATE team_brands SET color = ?, updated_at = ? WHERE team_id = ?",
  );
  const retainedColors = new Set(
    seededBrands.filter((brand) => BRAND_COLORS.includes(brand.color))
      .map((brand) => brand.color),
  );
  for (const brand of seededBrands) {
    if (BRAND_COLORS.includes(brand.color) || brand.color_changed_season !== null) continue;
    const replacement = BRAND_COLORS.find((color) => !retainedColors.has(color));
    if (!replacement) break;
    setSeededBrandColor.run(
      replacement,
      new Date().toISOString(),
      brand.team_id,
    );
    retainedColors.add(replacement);
  }

  const readTeamPlans = database.prepare(`
    SELECT team_id, car_one_name, car_two_name
    FROM team_plans
    ORDER BY team_id
  `);
  const readBrands = database.prepare(`
    SELECT team_id, name, abbreviation, color, name_changed_season,
           abbreviation_changed_season, color_changed_season
    FROM team_brands ORDER BY team_id
  `);
  const readBrand = database.prepare(`
    SELECT * FROM team_brands WHERE team_id = ?
  `);
  const readStints = database.prepare(`
    SELECT team_id, car_index, stint_index, driver_id, laps
    FROM relay_stints
    ORDER BY team_id, car_index, stint_index
  `);
  const readCars = database.prepare(`
    SELECT team_id, car_index, speed, handling, durability, feedback, weird
    FROM cars
    ORDER BY team_id, car_index
  `);
  const updateTeam = database.prepare(`
    UPDATE team_plans
    SET car_one_name = ?, car_two_name = ?, updated_at = ?
    WHERE team_id = ?
  `);
  const replaceStint = database.prepare(`
    INSERT INTO relay_stints (
      team_id, car_index, stint_index, driver_id, laps
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (team_id, car_index, stint_index)
    DO UPDATE SET driver_id = excluded.driver_id, laps = excluded.laps
  `);
  const readRoster = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns, source
    FROM racers
    WHERE team_id = ?
    ORDER BY rowid
  `);
  const readAllRacerNames = database.prepare("SELECT name FROM racers");
  const readDraftState = database.prepare("SELECT * FROM draft_state WHERE id = 1");
  const readDraftPicks = database.prepare(`
    SELECT draft_picks.pick_number, draft_picks.round_number,
           draft_picks.team_id, draft_picks.racer_id,
           draft_picks.picked_at, racers.name AS racer_name
    FROM draft_picks
    JOIN racers ON racers.id = draft_picks.racer_id
    ORDER BY pick_number
  `);
  const readDraftInitiationVotes = database.prepare(`
    SELECT season, team_id, voted_at, veteran_retention_id, rookie_retention_id
    FROM draft_initiation_votes
    WHERE season = ?
    ORDER BY voted_at, team_id
  `);
  const insertDraftInitiationVote = database.prepare(`
    INSERT OR IGNORE INTO draft_initiation_votes (
      season, team_id, voted_at, veteran_retention_id, rookie_retention_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const readDraftRetentionRoster = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns, source
    FROM racers
    WHERE team_id = ?
    ORDER BY rowid
  `);
  const returnNonRetainedRosterToDraft = database.prepare(`
    UPDATE racers
    SET team_id = NULL, source = 'draft'
    WHERE team_id = ? AND id NOT IN (?, ?)
  `);
  const readDraftPool = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns
    FROM racers
    WHERE source = 'draft' AND id NOT IN (SELECT racer_id FROM draft_picks)
    ORDER BY name
  `);
  const insertDraftState = database.prepare(`
    INSERT INTO draft_state (
      id, status, rounds, pool_size, seed, started_at, completed_at
    ) VALUES (1, 'active', ?, ?, ?, ?, NULL)
  `);
  const insertDraftPick = database.prepare(`
    INSERT INTO draft_picks (
      pick_number, round_number, team_id, racer_id, picked_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const findDraftRacer = database.prepare(`
    SELECT id FROM racers
    WHERE id = ? AND source = 'draft'
      AND id NOT IN (SELECT racer_id FROM draft_picks)
  `);
  const assignRacer = database.prepare("UPDATE racers SET team_id = ? WHERE id = ?");
  const clearRosters = database.prepare("UPDATE racers SET team_id = NULL WHERE team_id IS NOT NULL");
  const countDraftPoolRacers = database.prepare(`
    SELECT COUNT(*) AS count FROM racers WHERE source = 'draft'
  `);
  const trimDraftPoolRacers = database.prepare(`
    UPDATE racers
    SET source = 'relegated'
    WHERE id IN (
      SELECT id FROM racers
      WHERE source = 'draft'
      ORDER BY rowid DESC
      LIMIT ?
    )
  `);
  const completeDraft = database.prepare(`
    UPDATE draft_state SET status = 'complete', completed_at = ? WHERE id = 1
  `);
  const insertMartyrState = database.prepare(`
    INSERT OR IGNORE INTO initiation_martyr_state (
      season, status, racer_id, created_at, resolved_at
    ) VALUES (?, 'voting', NULL, ?, NULL)
  `);
  const readMartyrState = database.prepare(`
    SELECT initiation_martyr_state.*, racers.name AS racer_name,
           racers.pronouns AS racer_pronouns
    FROM initiation_martyr_state
    LEFT JOIN racers ON racers.id = initiation_martyr_state.racer_id
    WHERE season = ?
  `);
  const readMartyrVotes = database.prepare(`
    SELECT initiation_martyr_votes.team_id, initiation_martyr_votes.racer_id,
           initiation_martyr_votes.voted_at, racers.name AS racer_name
    FROM initiation_martyr_votes
    JOIN racers ON racers.id = initiation_martyr_votes.racer_id
    WHERE season = ?
    ORDER BY initiation_martyr_votes.voted_at, initiation_martyr_votes.team_id
  `);
  const readResolvedMartyrs = database.prepare(`
    SELECT initiation_martyr_state.season, initiation_martyr_state.resolved_at,
           racers.id AS racer_id, racers.name AS racer_name,
           racers.pronouns AS racer_pronouns
    FROM initiation_martyr_state
    JOIN racers ON racers.id = initiation_martyr_state.racer_id
    WHERE initiation_martyr_state.status = 'resolved'
    ORDER BY initiation_martyr_state.season DESC
  `);
  const insertMartyrVote = database.prepare(`
    INSERT INTO initiation_martyr_votes (season, team_id, racer_id, voted_at)
    VALUES (?, ?, ?, ?)
  `);
  const resolveMartyr = database.prepare(`
    UPDATE initiation_martyr_state
    SET status = 'resolved', racer_id = ?, resolved_at = ?
    WHERE season = ?
  `);
  const markRacerAsMartyr = database.prepare(`
    UPDATE racers SET source = 'martyr' WHERE id = ? AND team_id IS NULL
  `);
  const readRookieDraftState = database.prepare(`
    SELECT * FROM rookie_draft_state WHERE season = ?
  `);
  const insertRookieDraftState = database.prepare(`
    INSERT INTO rookie_draft_state (
      season, status, seed, order_json, current_pick,
      pick_deadline, started_at, completed_at
    ) VALUES (?, 'voting', ?, ?, 1, NULL, ?, NULL)
  `);
  const readRookieDraftInitiationVotes = database.prepare(`
    SELECT team_id, voted_at
    FROM rookie_draft_initiation_votes
    WHERE season = ?
    ORDER BY voted_at, team_id
  `);
  const insertRookieDraftInitiationVote = database.prepare(`
    INSERT OR IGNORE INTO rookie_draft_initiation_votes (season, team_id, voted_at)
    VALUES (?, ?, ?)
  `);
  const activateRookieDraftState = database.prepare(`
    UPDATE rookie_draft_state
    SET status = 'active', pick_deadline = ?
    WHERE season = ? AND status = 'voting'
  `);
  const readRookieDraftPicks = database.prepare(`
    SELECT rookie_draft_picks.*, racers.name AS racer_name
    FROM rookie_draft_picks
    JOIN racers ON racers.id = rookie_draft_picks.racer_id
    WHERE season = ?
    ORDER BY pick_number
  `);
  const readRookieDraftPool = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns
    FROM racers
    WHERE source = ? AND id NOT IN (
      SELECT racer_id FROM rookie_draft_picks WHERE season = ?
    )
    ORDER BY name
  `);
  const insertRookieDraftPick = database.prepare(`
    INSERT INTO rookie_draft_picks (
      season, pick_number, round_number, team_id,
      racer_id, automatic, picked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const advanceRookieDraft = database.prepare(`
    UPDATE rookie_draft_state
    SET current_pick = ?, pick_deadline = ?
    WHERE season = ?
  `);
  const beginRookieReleases = database.prepare(`
    UPDATE rookie_draft_state
    SET status = 'releases', current_pick = 13, pick_deadline = NULL
    WHERE season = ?
  `);
  const readRookieReleases = database.prepare(`
    SELECT rookie_draft_releases.*, racers.name AS racer_name
    FROM rookie_draft_releases
    JOIN racers ON racers.id = rookie_draft_releases.racer_id
    WHERE season = ?
    ORDER BY released_at, team_id
  `);
  const insertRookieRelease = database.prepare(`
    INSERT INTO rookie_draft_releases (season, team_id, racer_id, released_at)
    VALUES (?, ?, ?, ?)
  `);
  const completeRookieDraft = database.prepare(`
    UPDATE rookie_draft_state
    SET status = 'complete', completed_at = ?
    WHERE season = ?
  `);
  const clearTeamStints = database.prepare("DELETE FROM relay_stints WHERE team_id = ?");
  const pickedRacersForTeam = database.prepare(`
    SELECT racer_id FROM draft_picks WHERE team_id = ? ORDER BY pick_number
  `);
  const readNonDraftFreeAgents = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns, team_id, source
    FROM racers
    WHERE team_id IS NULL AND source NOT IN ('draft', 'martyr', 'relegated')
    ORDER BY name
  `);
  const readAllFreeAgents = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns
    FROM racers
    WHERE team_id IS NULL AND source NOT IN ('martyr', 'relegated')
    ORDER BY name
  `);
  const readSignedRacers = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns, team_id, source
    FROM racers
    WHERE team_id IS NOT NULL
    ORDER BY team_id, name
  `);
  const readFreeAgentDirectory = database.prepare(`
    SELECT id, name, pace, control, overtaking, stamina, technical,
           weird, speed_mark, potential, note, pronouns, team_id, source
    FROM racers
    WHERE team_id IS NULL AND source NOT IN ('martyr', 'relegated')
    ORDER BY name
  `);
  const readTradeOffers = database.prepare(`
    SELECT trade_offers.*, offered.name AS offered_racer_name,
           requested.name AS requested_racer_name
    FROM trade_offers
    JOIN racers AS offered ON offered.id = trade_offers.offered_racer_id
    JOIN racers AS requested ON requested.id = trade_offers.requested_racer_id
    ORDER BY trade_offers.id DESC
  `);
  const readTradeOffer = database.prepare(`
    SELECT * FROM trade_offers WHERE id = ?
  `);
  const findRosterRacer = database.prepare(`
    SELECT id, team_id, source FROM racers WHERE id = ?
  `);
  const insertTradeOffer = database.prepare(`
    INSERT INTO trade_offers (
      offering_team_id, receiving_team_id, offered_racer_id,
      requested_racer_id, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
  `);
  const resolveTradeOffer = database.prepare(`
    UPDATE trade_offers SET status = ?, resolved_at = ? WHERE id = ?
  `);
  const readTradeAlertReads = database.prepare(`
    SELECT alert_id FROM trade_alert_reads WHERE username = ?
  `);
  const insertTradeAlertRead = database.prepare(`
    INSERT OR IGNORE INTO trade_alert_reads (username, alert_id, seen_at)
    VALUES (?, ?, ?)
  `);
  const readDraftVoteAlertReads = database.prepare(`
    SELECT alert_id FROM draft_vote_alert_reads WHERE username = ?
  `);
  const insertDraftVoteAlertRead = database.prepare(`
    INSERT OR IGNORE INTO draft_vote_alert_reads (username, alert_id, seen_at)
    VALUES (?, ?, ?)
  `);
  const readMediaEntries = database.prepare(`
    SELECT id, title, body, author_username, created_at, updated_at
    FROM media_entries
    ORDER BY created_at DESC, id DESC
  `);
  const readMediaEntry = database.prepare(`
    SELECT id, title, body, author_username, created_at, updated_at
    FROM media_entries
    WHERE id = ?
  `);
  const readMediaEntryReads = database.prepare(`
    SELECT media_entry_id FROM media_entry_reads WHERE username = ?
  `);
  const insertMediaEntryRead = database.prepare(`
    INSERT OR IGNORE INTO media_entry_reads (username, media_entry_id, seen_at)
    VALUES (?, ?, ?)
  `);
  const insertMediaEntry = database.prepare(`
    INSERT INTO media_entries (title, body, author_username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateMediaEntryRecord = database.prepare(`
    UPDATE media_entries
    SET title = ?, body = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteMediaEntryRecord = database.prepare(`
    DELETE FROM media_entries WHERE id = ?
  `);
  const replaceRelayDriver = database.prepare(`
    UPDATE relay_stints SET driver_id = ?
    WHERE team_id = ? AND driver_id = ?
  `);
  const readTeamStints = database.prepare(`
    SELECT car_index, stint_index, driver_id, laps
    FROM relay_stints WHERE team_id = ?
    ORDER BY car_index, stint_index
  `);
  const insertTransaction = database.prepare(`
    INSERT INTO transactions (
      type, team_id, other_team_id, acquired_racer_id,
      moved_racer_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const readTransactions = database.prepare(`
    SELECT transactions.*, acquired.name AS acquired_racer_name,
           moved.name AS moved_racer_name
    FROM transactions
    LEFT JOIN racers AS acquired ON acquired.id = transactions.acquired_racer_id
    LEFT JOIN racers AS moved ON moved.id = transactions.moved_racer_id
    ORDER BY transactions.id DESC
    LIMIT 100
  `);

  function repairTeamRelayPlan(teamId) {
    const roster = readRoster.all(teamId);
    if (roster.length === 0) return;
    const validDriverIds = new Set(roster.map((racer) => racer.id));
    const availableDriverIds = roster.map((racer) => racer.id);
    const usedDriverIds = new Set();
    for (const stint of readTeamStints.all(teamId)) {
      let driverId = stint.driver_id;
      if (!validDriverIds.has(driverId) || usedDriverIds.has(driverId)) {
        driverId = availableDriverIds.find((id) => !usedDriverIds.has(id));
      }
      if (!driverId) throw new Error("A valid relay plan requires at least six signed racers.");
      usedDriverIds.add(driverId);
      if (driverId !== stint.driver_id) {
        replaceStint.run(
          teamId,
          stint.car_index,
          stint.stint_index,
          driverId,
          stint.laps,
        );
      }
    }
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const team of teams) repairTeamRelayPlan(team.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const readAllRacersForGrowth = database.prepare(`
    SELECT id, pace, control, overtaking, stamina, technical,
           weird, potential
    FROM racers
  `);
  const countGrowthRows = database.prepare(`
    SELECT COUNT(*) AS count FROM racer_growth WHERE racer_id = ?
  `);
  const insertGrowth = database.prepare(`
    INSERT OR IGNORE INTO racer_growth (
      racer_id, stat, remaining, discovered_cap
    ) VALUES (?, ?, ?, 0)
  `);
  const readDiscoveredCaps = database.prepare(`
    SELECT stat FROM racer_growth
    WHERE racer_id = ? AND discovered_cap = 1
    ORDER BY stat
  `);
  const readGrowth = database.prepare(`
    SELECT remaining, discovered_cap FROM racer_growth
    WHERE racer_id = ? AND stat = ?
  `);
  const reduceGrowth = database.prepare(`
    UPDATE racer_growth SET remaining = remaining - 1
    WHERE racer_id = ? AND stat = ? AND remaining > 0
  `);
  const revealCap = database.prepare(`
    UPDATE racer_growth SET discovered_cap = 1
    WHERE racer_id = ? AND stat = ?
  `);
  const reducePotential = database.prepare(`
    UPDATE racers SET potential = potential - 1
    WHERE id = ? AND potential > 0
  `);
  const readUpgradeWeek = database.prepare(`
    SELECT week, option_one, option_two, option_three
    FROM weekly_upgrade_weeks WHERE week = ?
  `);
  const insertUpgradeWeek = database.prepare(`
    INSERT OR IGNORE INTO weekly_upgrade_weeks (
      week, option_one, option_two, option_three, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const readUpgradeChoices = database.prepare(`
    SELECT weekly_upgrade_choices.*, racers.name AS racer_name
    FROM weekly_upgrade_choices
    JOIN racers ON racers.id = weekly_upgrade_choices.racer_id
    WHERE week = ?
    ORDER BY created_at
  `);
  const readTeamUpgradeChoice = database.prepare(`
    SELECT * FROM weekly_upgrade_choices WHERE week = ? AND team_id = ?
  `);
  const insertUpgradeChoice = database.prepare(`
    INSERT INTO weekly_upgrade_choices (
      week, team_id, option_index, racer_id, stat, result, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(week, team_id) DO UPDATE SET
      option_index = excluded.option_index,
      racer_id = excluded.racer_id,
      stat = excluded.stat,
      result = excluded.result,
      created_at = excluded.created_at,
      applied_at = NULL
    WHERE weekly_upgrade_choices.applied_at IS NULL
  `);
  const readPendingUpgradeChoices = database.prepare(`
    SELECT * FROM weekly_upgrade_choices
    WHERE week = ? AND applied_at IS NULL
    ORDER BY created_at
  `);
  const markUpgradeChoiceApplied = database.prepare(`
    UPDATE weekly_upgrade_choices
    SET result = ?, applied_at = ?
    WHERE week = ? AND team_id = ?
  `);
  const readCarUpgradeWeek = database.prepare(`
    SELECT week, option_one, option_two, option_three
    FROM weekly_car_upgrade_weeks WHERE week = ?
  `);
  const insertCarUpgradeWeek = database.prepare(`
    INSERT OR IGNORE INTO weekly_car_upgrade_weeks (
      week, option_one, option_two, option_three, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const readCarUpgradeChoices = database.prepare(`
    SELECT * FROM weekly_car_upgrade_choices
    WHERE week = ?
    ORDER BY created_at
  `);
  const readTeamCarUpgradeChoice = database.prepare(`
    SELECT * FROM weekly_car_upgrade_choices WHERE week = ? AND team_id = ?
  `);
  const insertCarUpgradeChoice = database.prepare(`
    INSERT INTO weekly_car_upgrade_choices (
      week, team_id, option_index, car_index, stat, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(week, team_id) DO UPDATE SET
      option_index = excluded.option_index,
      car_index = excluded.car_index,
      stat = excluded.stat,
      created_at = excluded.created_at,
      applied_at = NULL
    WHERE weekly_car_upgrade_choices.applied_at IS NULL
  `);
  const readPendingCarUpgradeChoices = database.prepare(`
    SELECT * FROM weekly_car_upgrade_choices
    WHERE week = ? AND applied_at IS NULL
    ORDER BY created_at
  `);
  const markCarUpgradeChoiceApplied = database.prepare(`
    UPDATE weekly_car_upgrade_choices
    SET applied_at = ?
    WHERE week = ? AND team_id = ?
  `);
  const readCar = database.prepare(`
    SELECT * FROM cars WHERE team_id = ? AND car_index = ?
  `);
  const insertRaceParticipation = database.prepare(`
    INSERT OR IGNORE INTO weekly_race_participation (
      week, racer_id, team_id, first_used_at
    ) VALUES (?, ?, ?, ?)
  `);
  const readEligibleRacers = database.prepare(`
    SELECT racers.team_id, weekly_race_participation.racer_id
    FROM weekly_race_participation
    JOIN racers ON racers.id = weekly_race_participation.racer_id
    WHERE weekly_race_participation.week = ? AND racers.team_id IS NOT NULL
    ORDER BY racers.team_id, racers.rowid
  `);
  const readRacerParticipation = database.prepare(`
    SELECT 1 FROM weekly_race_participation
    WHERE week = ? AND racer_id = ?
  `);
  const countWeekRaces = database.prepare(`
    SELECT COUNT(*) AS count FROM races WHERE season = ? AND week = ?
  `);
  const countSeasonRaces = database.prepare(`
    SELECT COUNT(*) AS count FROM races WHERE season = ?
  `);
  const readLatestSeasonRace = database.prepare(`
    SELECT start_at, created_at
    FROM races
    WHERE season = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const insertRace = database.prepare(`
    INSERT INTO races (
      season, week, race_number, course_name, seed, duration,
      entries_json, events_json, standings_json, created_at, start_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRaceResult = database.prepare(`
    INSERT INTO race_results (
      race_id, entry_id, team_id, car_name, position, points
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertRaceLap = database.prepare(`
    INSERT INTO race_laps (
      race_id, season, week, race_number, course_name,
      entry_id, team_id, car_name, racer_id, racer_name,
      role, lap, lap_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readRace = database.prepare("SELECT * FROM races WHERE id = ?");
  const readCompletedRaceLaps = database.prepare(`
    SELECT race_laps.*
    FROM race_laps
    WHERE race_id != COALESCE((SELECT active_race_id FROM league_runtime WHERE id = 1), -1)
    ORDER BY race_id, entry_id, lap
  `);
  const readRaceLapsForRace = database.prepare(`
    SELECT *
    FROM race_laps
    WHERE race_id = ?
    ORDER BY entry_id, lap
  `);
  const readRaceParticipantsForDebuts = database.prepare(`
    SELECT DISTINCT race_laps.racer_id, race_laps.racer_name, racers.source
    FROM race_laps
    JOIN racers ON racers.id = race_laps.racer_id
    WHERE race_laps.race_id = ?
    ORDER BY race_laps.racer_name
  `);
  const countPriorCareerRacesForRacer = database.prepare(`
    SELECT COUNT(DISTINCT race_id) AS count
    FROM race_laps
    WHERE racer_id = ? AND race_id != ?
  `);
  const countPriorSeasonRacesForRacer = database.prepare(`
    SELECT COUNT(DISTINCT race_id) AS count
    FROM race_laps
    WHERE racer_id = ? AND season = ? AND race_id != ?
  `);
  const readLatestCompletedSeasonRace = database.prepare(`
    SELECT *
    FROM races
    WHERE season = ?
      AND id != COALESCE((SELECT active_race_id FROM league_runtime WHERE id = 1), -1)
    ORDER BY id DESC
    LIMIT 1
  `);
  const readAllRacePayloads = database.prepare(`
    SELECT id, entries_json, events_json FROM races
  `);
  const updateRacePayload = database.prepare(`
    UPDATE races SET entries_json = ?, events_json = ?, recap_text = NULL WHERE id = ?
  `);
  const updateRaceRecap = database.prepare(`
    UPDATE races SET recap_text = ? WHERE id = ?
  `);
  for (const race of readAllRacePayloads.all()) {
    const entries = JSON.parse(race.entries_json);
    const events = JSON.parse(race.events_json);
    const drivers = [...new Map(entries.flatMap((entry) => (
      entry.stints.map((stint) => [stint.driver.id, stint.driver])
    ))).values()];
    let changed = false;
    for (const event of events) {
      let message = event.message;
      for (const driver of drivers) {
        message = personalizeRaceFeedMessage(message, driver);
      }
      if (event.type === "strange") {
        message = appendStrangeEffectSummary(message);
      }
      if (message !== event.message) {
        event.message = message;
        changed = true;
      }
    }
    if (changed) {
      updateRacePayload.run(race.entries_json, JSON.stringify(events), race.id);
    }
  }
  const updateRaceResultCarName = database.prepare(`
    UPDATE race_results SET car_name = ? WHERE entry_id = ?
  `);
  const readAllRacesForCareer = database.prepare(`
    SELECT id, season, entries_json, standings_json FROM races ORDER BY id
  `);
  const readSeasonHistory = database.prepare(`
    SELECT season, team_standings_json, mvd_standings_json,
           champions_json, opening_draft_json, rookie_draft_json, finalized_at
    FROM season_history ORDER BY season DESC
  `);
  const insertSeasonHistory = database.prepare(`
    INSERT OR IGNORE INTO season_history (
      season, team_standings_json, mvd_standings_json,
      champions_json, opening_draft_json, rookie_draft_json, finalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateSeasonDraftHistory = database.prepare(`
    UPDATE season_history
    SET opening_draft_json = ?, rookie_draft_json = ?
    WHERE season = ?
  `);
  const readManager = database.prepare("SELECT * FROM managers WHERE username = ?");
  const readManagerProfiles = database.prepare(`
    SELECT username, team_id
    FROM managers
    ORDER BY username = ? DESC, username
  `);
  const readManagerTeams = database.prepare("SELECT team_id FROM managers WHERE team_id IS NOT NULL ORDER BY created_at, username");
  const readManagersWithoutTeams = database.prepare("SELECT username FROM managers WHERE team_id IS NULL ORDER BY created_at, username");
  const assignManagerTeam = database.prepare("UPDATE managers SET team_id = ? WHERE username = ?");
  const insertManager = database.prepare(`
    INSERT INTO managers (username, password_salt, password_hash, team_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertStewardManager = database.prepare(`
    INSERT INTO managers (username, password_salt, password_hash, team_id, created_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash,
      team_id = NULL
  `);
  const clearStewardManagerTeam = database.prepare(`
    UPDATE managers SET team_id = NULL WHERE username = ?
  `);
  const insertManagerSession = database.prepare(`
    INSERT INTO manager_sessions (id, username, team_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const readManagerSession = database.prepare(`
    SELECT id, username, team_id, expires_at
    FROM manager_sessions
    WHERE id = ?
  `);
  const deleteManagerSession = database.prepare(`
    DELETE FROM manager_sessions WHERE id = ?
  `);
  const deleteExpiredManagerSessions = database.prepare(`
    DELETE FROM manager_sessions WHERE expires_at <= ?
  `);
  const readRaceSeasons = database.prepare(`
    SELECT DISTINCT season FROM races ORDER BY season
  `);
  const readSeasonRacesForChampionship = database.prepare(`
    SELECT id, season, entries_json, standings_json
    FROM races WHERE season = ? ORDER BY id
  `);
  const readRaceSummaries = database.prepare(`
    SELECT races.id, races.season, races.week, races.race_number,
           races.course_name, races.duration, races.created_at,
           race_results.car_name AS winner_car,
           race_results.team_id AS winner_team_id
    FROM races
    JOIN race_results
      ON race_results.race_id = races.id AND race_results.position = 1
    ORDER BY races.season DESC, races.week DESC, races.race_number DESC
  `);
  const readRuntime = database.prepare(`
    SELECT active_race_id, active_season FROM league_runtime WHERE id = 1
  `);
  const setActiveRace = database.prepare(`
    UPDATE league_runtime SET active_race_id = ?, updated_at = ? WHERE id = 1
  `);
  const setActiveSeason = database.prepare(`
    UPDATE league_runtime SET active_season = ?, updated_at = ? WHERE id = 1
  `);
  const clearDraftPicks = database.prepare("DELETE FROM draft_picks");
  const clearDraftState = database.prepare("DELETE FROM draft_state");
  const clearDraftInitiationVotes = database.prepare("DELETE FROM draft_initiation_votes WHERE season = ?");
  const cancelPendingTrades = database.prepare(`
    UPDATE trade_offers
    SET status = 'cancelled', resolved_at = ?
    WHERE status = 'pending'
  `);
  const graduateOpeningDraftClass = database.prepare(`
    UPDATE racers SET source = 'veteran' WHERE source = 'draft'
  `);
  const relegateFreeAgents = database.prepare(`
    UPDATE racers
    SET source = 'relegated'
    WHERE team_id IS NULL AND source != 'martyr'
  `);
  const returnRostersToDraft = database.prepare(`
    UPDATE racers
    SET team_id = NULL, source = 'draft'
    WHERE team_id IS NOT NULL
  `);
  const countSignedRacers = database.prepare(`
    SELECT COUNT(*) AS count FROM racers WHERE team_id IS NOT NULL
  `);
  const returnInitialRostersToFirstDraft = database.prepare(`
    UPDATE racers
    SET team_id = NULL, source = 'draft'
    WHERE source = 'initial'
  `);
  const moveSeededFreeAgentsToFirstDraft = database.prepare(`
    UPDATE racers
    SET source = 'draft'
    WHERE source = 'free_agent'
  `);
  const countStaleFirstDraftRacers = database.prepare(`
    SELECT COUNT(1) AS count
    FROM racers
    WHERE team_id IS NOT NULL
      OR source IN ('initial', 'free_agent')
      OR id LIKE 'free-agent-%'
      OR (source = 'draft' AND id NOT LIKE 'opening-draft-%')
  `);
  const deleteAllRacerGrowth = database.prepare("DELETE FROM racer_growth");
  const deleteAllTradeOffers = database.prepare("DELETE FROM trade_offers");
  const deleteAllTransactions = database.prepare("DELETE FROM transactions");
  const deleteAllRacers = database.prepare("DELETE FROM racers");
  const grantSpeedMark = database.prepare(`
    UPDATE racers
    SET weird = MIN(10, weird + 2), speed_mark = 1
    WHERE id = ? AND speed_mark = 0
  `);
  const deleteRaceResultsForSeason = database.prepare(`
    DELETE FROM race_results WHERE race_id IN (SELECT id FROM races WHERE season = ?)
  `);
  const deleteRacesForSeason = database.prepare("DELETE FROM races WHERE season = ?");
  const deleteRookieDraftPicksForSeason = database.prepare("DELETE FROM rookie_draft_picks WHERE season = ?");
  const deleteRookieDraftReleasesForSeason = database.prepare("DELETE FROM rookie_draft_releases WHERE season = ?");
  const deleteRookieDraftInitiationVotesForSeason = database.prepare("DELETE FROM rookie_draft_initiation_votes WHERE season = ?");
  const deleteRookieDraftStateForSeason = database.prepare("DELETE FROM rookie_draft_state WHERE season = ?");
  const deleteMartyrVotesForSeason = database.prepare("DELETE FROM initiation_martyr_votes WHERE season = ?");
  const deleteMartyrStateForSeason = database.prepare("DELETE FROM initiation_martyr_state WHERE season = ?");
  const deleteSeasonHistoryForSeason = database.prepare("DELETE FROM season_history WHERE season = ?");
  const deleteRaceParticipationForSeason = database.prepare(
    "DELETE FROM weekly_race_participation WHERE week BETWEEN ? AND ?",
  );
  const deleteUpgradeChoicesForSeason = database.prepare(
    "DELETE FROM weekly_upgrade_choices WHERE week BETWEEN ? AND ?",
  );
  const deleteUpgradeWeeksForSeason = database.prepare(
    "DELETE FROM weekly_upgrade_weeks WHERE week BETWEEN ? AND ?",
  );
  const deleteCarUpgradeChoicesForSeason = database.prepare(
    "DELETE FROM weekly_car_upgrade_choices WHERE week BETWEEN ? AND ?",
  );
  const deleteCarUpgradeWeeksForSeason = database.prepare(
    "DELETE FROM weekly_car_upgrade_weeks WHERE week BETWEEN ? AND ?",
  );

  function nextAvailableManagerTeamId() {
    const assignedTeamIds = new Set(readManagerTeams.all().map((row) => row.team_id));
    return teams.find((team) => !assignedTeamIds.has(team.id))?.id || null;
  }

  clearStewardManagerTeam.run(STEWARD_USERNAME);
  for (const manager of readManagersWithoutTeams.all()) {
    if (manager.username === STEWARD_USERNAME) continue;
    const teamId = nextAvailableManagerTeamId();
    if (!teamId) break;
    assignManagerTeam.run(teamId, manager.username);
  }
  const stewardSalt = randomBytes(16).toString("hex");
  upsertStewardManager.run(
    STEWARD_USERNAME,
    stewardSalt,
    hashPassword(STEWARD_PASSWORD, stewardSalt),
    new Date().toISOString(),
  );

  function ensureGrowthRows() {
    for (const racer of readAllRacersForGrowth.all()) {
      if (countGrowthRows.get(racer.id).count === TRAINABLE_STATS.length) continue;
      const allocations = Object.fromEntries(TRAINABLE_STATS.map((stat) => [stat, 0]));
      const random = seededRandom(hashText(`growth:${racer.id}`));
      for (let point = 0; point < racer.potential; point += 1) {
        const eligible = TRAINABLE_STATS.filter(
          (stat) => racer[stat] + allocations[stat] < 10,
        );
        if (!eligible.length) break;
        const stat = eligible[Math.floor(random() * eligible.length)];
        allocations[stat] += 1;
      }
      for (const stat of TRAINABLE_STATS) {
        insertGrowth.run(racer.id, stat, allocations[stat]);
      }
    }
  }

  function ensureUpgradeWeek(week = 1) {
    if (!readUpgradeWeek.get(week)) {
      const random = seededRandom(hashText(`upgrade-week:${week}`));
      const options = [...TRAINABLE_STATS];
      for (let index = options.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [options[index], options[swapIndex]] = [options[swapIndex], options[index]];
      }
      insertUpgradeWeek.run(
        week,
        options[0],
        options[1],
        options[2],
        new Date().toISOString(),
      );
    }
    return readUpgradeWeek.get(week);
  }

  function ensureCarUpgradeWeek(week = 1) {
    if (!readCarUpgradeWeek.get(week)) {
      const random = seededRandom(hashText(`car-upgrade-week:${week}`));
      const options = [...CAR_STATS];
      for (let index = options.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [options[index], options[swapIndex]] = [options[swapIndex], options[index]];
      }
      insertCarUpgradeWeek.run(
        week,
        options[0],
        options[1],
        options[2],
        new Date().toISOString(),
      );
    }
    return readCarUpgradeWeek.get(week);
  }

  function applyPendingDevelopmentWeek(week, appliedAt = new Date().toISOString()) {
    for (const choice of readPendingUpgradeChoices.all(week)) {
      const racer = findRosterRacer.get(choice.racer_id);
      if (!racer || racer.team_id !== choice.team_id) {
        markUpgradeChoiceApplied.run("capped", appliedAt, choice.week, choice.team_id);
        continue;
      }
      const growth = readGrowth.get(choice.racer_id, choice.stat);
      if (!growth) throw new Error("Racer growth data is unavailable.");
      const result = growth.remaining > 0 ? "improved" : "capped";
      if (result === "improved") {
        database.prepare(`UPDATE racers SET ${choice.stat} = ${choice.stat} + 1 WHERE id = ?`)
          .run(choice.racer_id);
        reduceGrowth.run(choice.racer_id, choice.stat);
        reducePotential.run(choice.racer_id);
      } else {
        revealCap.run(choice.racer_id, choice.stat);
      }
      markUpgradeChoiceApplied.run(result, appliedAt, choice.week, choice.team_id);
    }

    for (const choice of readPendingCarUpgradeChoices.all(week)) {
      const car = readCar.get(choice.team_id, choice.car_index);
      if (car && car[choice.stat] < 10) {
        database.prepare(`UPDATE cars SET ${choice.stat} = ${choice.stat} + 1
          WHERE team_id = ? AND car_index = ?`).run(choice.team_id, choice.car_index);
      }
      markCarUpgradeChoiceApplied.run(appliedAt, choice.week, choice.team_id);
    }
  }

  function developmentWeekDate(week, dayOffsetFromFriday, hour, minute) {
    const draft = readDraftState.get();
    if (!draft?.started_at) return null;
    const firstRaceAt = firstRaceAtForDraft(draft.started_at);
    const weekInSeason = displayWeekForKey(week);
    const fridayRaceAt = scheduledRaceAtForIndex(firstRaceAt, ((weekInSeason - 1) * RACES_PER_WEEK) + 4);
    const targetParts = addEasternDays(easternParts(new Date(fridayRaceAt)), dayOffsetFromFriday);
    return easternWallTimeToDate(targetParts, hour, minute);
  }

  function developmentApplyAt(week) {
    return developmentWeekDate(week, 2, 0, 1);
  }

  function developmentCutoffAt(week) {
    return developmentWeekDate(week, 3, 0, 0);
  }

  function applyDueDevelopment(now = new Date()) {
    const activeSeason = getActiveSeason();
    const firstWeek = seasonWeekKey(activeSeason, 1);
    const lastWeek = seasonWeekKey(activeSeason, WEEKS_PER_SEASON);
    for (let week = firstWeek; week <= lastWeek; week += 1) {
      const applyAt = developmentApplyAt(week);
      if (applyAt && now >= applyAt) applyPendingDevelopmentWeek(week, now.toISOString());
    }
  }

  function applyChoiceIfDue(week, now = new Date()) {
    const applyAt = developmentApplyAt(week);
    if (applyAt && now >= applyAt) applyPendingDevelopmentWeek(week, now.toISOString());
  }

  function assertDevelopmentChoiceOpen(week, now = new Date()) {
    const cutoffAt = developmentCutoffAt(week);
    if (cutoffAt && now >= cutoffAt) {
      throw new Error("This week's Training and Upgrade choices are closed.");
    }
  }

  function seasonWeekKey(season, week) {
    return ((season - 1) * WEEKS_PER_SEASON) + week;
  }

  ensureGrowthRows();
  ensureUpgradeWeek(1);
  ensureCarUpgradeWeek(1);

  function publicRacer(racer) {
    return {
      ...racer,
      leagueOrigin: leagueOriginForRacer(racer),
      cappedStats: readDiscoveredCaps.all(racer.id).map((row) => row.stat),
    };
  }

  function insertOrReactivateGeneratedRacer(
    id,
    name,
    pace,
    control,
    overtaking,
    stamina,
    technical,
    weird,
    potential,
    note,
    pronouns,
    teamId,
    source,
  ) {
    insertRacer.run(
      id,
      name,
      pace,
      control,
      overtaking,
      stamina,
      technical,
      weird,
      potential,
      note,
      pronouns,
      teamId,
      source,
    );
    reactivateGeneratedRacer.run(
      name,
      pace,
      control,
      overtaking,
      stamina,
      technical,
      weird,
      potential,
      note,
      pronouns,
      teamId,
      source,
      id,
    );
  }

  function getLeagueState() {
    const lineups = {};
    const carNames = {};
    const cars = {};
    const rosters = {};
    for (const row of readTeamPlans.all()) {
      lineups[row.team_id] = [];
      carNames[row.team_id] = [row.car_one_name, row.car_two_name];
      cars[row.team_id] = [];
      rosters[row.team_id] = readRoster.all(row.team_id).map(publicRacer);
    }
    for (const row of readStints.all()) {
      lineups[row.team_id].push({
        driverId: row.driver_id,
        laps: row.laps,
      });
    }
    for (const row of readCars.all()) {
      cars[row.team_id].push({
        carIndex: row.car_index,
        speed: row.speed,
        handling: row.handling,
        durability: row.durability,
        feedback: row.feedback,
        weird: row.weird,
      });
    }
    return {
      lineups,
      carNames,
      cars,
      rosters,
      brands: readBrands.all(),
      brandColors: BRAND_COLORS,
    };
  }

  function updateTeamBrand(teamId, element, value, season = 1) {
    const team = teams.find((item) => item.id === teamId);
    if (!team) throw new Error("Unknown team.");
    if (!["name", "abbreviation", "color"].includes(element)) {
      throw new Error("Unknown brand element.");
    }
    const brand = readBrand.get(teamId);
    const lockColumn = `${element}_changed_season`;
    if (element !== "color" && brand[lockColumn] === season) {
      throw new Error(`This team's ${element} has already been changed this season.`);
    }

    let nextValue = String(value).trim();
    if (element === "name") {
      if (nextValue.length < 2 || nextValue.length > 40) {
        throw new Error("Team names must contain 2 to 40 characters.");
      }
    } else if (element === "abbreviation") {
      nextValue = nextValue.toUpperCase();
      if (!/^[A-Z0-9]{3}$/.test(nextValue)) {
        throw new Error("Abbreviations must contain exactly 3 letters or numbers.");
      }
    } else if (!BRAND_COLORS.includes(nextValue)) {
      throw new Error("That color is not in the league palette.");
    }

    if (String(brand[element]).toLocaleLowerCase() === nextValue.toLocaleLowerCase()) {
      throw new Error(`Choose a different ${element} before saving.`);
    }

    const conflict = readBrands.all().find((other) => (
      other.team_id !== teamId
      && String(other[element]).toLocaleLowerCase() === nextValue.toLocaleLowerCase()
    ));
    if (conflict) throw new Error(`That ${element} is already in use.`);

    const oldShort = brand.abbreviation;
    database.exec("BEGIN IMMEDIATE");
    try {
      if (element === "color") {
        database.prepare(`
          UPDATE team_brands
          SET color = ?, updated_at = ?
          WHERE team_id = ?
        `).run(nextValue, new Date().toISOString(), teamId);
      } else {
        database.prepare(`
          UPDATE team_brands
          SET ${element} = ?, ${lockColumn} = ?, updated_at = ?
          WHERE team_id = ?
        `).run(nextValue, season, new Date().toISOString(), teamId);
      }

      if (element === "abbreviation") {
        for (const race of readAllRacePayloads.all()) {
          const entries = JSON.parse(race.entries_json);
          const events = JSON.parse(race.events_json);
          let changed = false;
          for (const entry of entries) {
            if (entry.teamId !== teamId) continue;
            entry.teamShort = nextValue;
            entry.carName = entry.carName.replace(`${oldShort} `, `${nextValue} `);
            changed = true;
          }
          for (const event of events) {
            if (typeof event.message === "string" && event.message.includes(`${oldShort} `)) {
              event.message = event.message.replaceAll(`${oldShort} `, `${nextValue} `);
              changed = true;
            }
          }
          if (changed) updateRacePayload.run(
            JSON.stringify(entries),
            JSON.stringify(events),
            race.id,
          );
        }
        database.prepare(`
          UPDATE race_results
          SET car_name = ? || substr(car_name, instr(car_name, ' '))
          WHERE team_id = ?
        `).run(nextValue, teamId);
      } else if (element === "name") {
        for (const race of readAllRacePayloads.all()) {
          const entries = JSON.parse(race.entries_json);
          let changed = false;
          for (const entry of entries) {
            if (entry.teamId !== teamId) continue;
            entry.teamName = nextValue;
            changed = true;
          }
          if (changed) updateRacePayload.run(
            JSON.stringify(entries),
            race.events_json,
            race.id,
          );
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new Error(`That ${element} is already in use.`);
      }
      throw error;
    }

    return readBrand.get(teamId);
  }

  function relayPlansLockedForRaceWindow() {
    if (readRuntime.get().active_race_id !== null) {
      return true;
    }
    const season = getActiveSeason();
    const seasonRacesRun = countSeasonRaces.get(season).count;
    if (seasonRacesRun >= SEASON_RACES) return false;
    const draft = readDraftState.get();
    const firstRaceAt = draft?.started_at
      ? firstRaceAtForDraft(draft.started_at)
      : null;
    if (!firstRaceAt) return false;
    const latestSeasonRace = readLatestSeasonRace.get(season);
    const nextRaceAt = latestSeasonRace
      ? nextWeekdayRaceAt(latestSeasonRace.start_at || latestSeasonRace.created_at)
      : nextAvailableRaceAt(firstRaceAt, 0);
    return Boolean(
      nextRaceAt
      && Date.now() >= new Date(nextRaceAt).getTime() - QUALIFIER_LOCK_MS,
    );
  }

  function saveTeamPlan(teamId, input) {
    if (relayPlansLockedForRaceWindow()) {
      throw new Error("You will be able to edit your relay plan after today's race.");
    }
    const team = teams.find((item) => item.id === teamId);
    if (!team) throw new Error("Unknown team.");
    const plan = validatePlan(team, readRoster.all(teamId), input);

    database.exec("BEGIN");
    try {
      updateTeam.run(plan.carNames[0], plan.carNames[1], new Date().toISOString(), teamId);
      plan.lineup.forEach((assignment, slot) => {
        replaceStint.run(
          teamId,
          Math.floor(slot / 3),
          slot % 3,
          assignment.driverId,
          assignment.laps,
        );
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      teamId,
      lineup: plan.lineup,
      carNames: plan.carNames,
    };
  }

  function renameCar(teamId, carIndex, name) {
    if (readRuntime.get().active_race_id !== null) {
      throw new Error("Car names are locked while a league race is happening.");
    }
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    if (![0, 1].includes(carIndex)) throw new Error("Unknown car.");
    const suffix = String(name).trim();
    if (!suffix || suffix.length > 32) {
      throw new Error("A car name must contain 1 to 32 characters.");
    }
    const current = readTeamPlans.all().find((row) => row.team_id === teamId);
    const carNames = [current.car_one_name, current.car_two_name];
    const abbreviation = readBrand.get(teamId).abbreviation;
    const oldFullName = `${abbreviation} ${carNames[carIndex]}`;
    carNames[carIndex] = suffix;
    if (carNames[0].toLocaleLowerCase() === carNames[1].toLocaleLowerCase()) {
      throw new Error("A team's two cars need different names.");
    }
    const newFullName = `${abbreviation} ${suffix}`;
    const entryId = `${teamId}-${carIndex + 1}`;
    database.exec("BEGIN IMMEDIATE");
    try {
      updateTeam.run(carNames[0], carNames[1], new Date().toISOString(), teamId);
      for (const race of readAllRacePayloads.all()) {
        const entries = JSON.parse(race.entries_json);
        const events = JSON.parse(race.events_json);
        let changed = false;
        for (const entry of entries) {
          if (entry.id === entryId) {
            entry.carName = newFullName;
            changed = true;
          }
        }
        for (const event of events) {
          if (typeof event.message === "string" && event.message.includes(oldFullName)) {
            event.message = event.message.replaceAll(oldFullName, newFullName);
            changed = true;
          }
        }
        if (changed) {
          updateRacePayload.run(
            JSON.stringify(entries),
            JSON.stringify(events),
            race.id,
          );
        }
      }
      updateRaceResultCarName.run(newFullName, entryId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { teamId, carNames };
  }

  function getDraft() {
    const draft = readDraftState.get();
    const season = getActiveSeason();
    const initiationVotes = readDraftInitiationVotes.all(season);
    const retentionRequired = season > 1;
    const retentionByTeam = Object.fromEntries(initiationVotes.map((vote) => [
      vote.team_id,
      {
        veteranRacerId: vote.veteran_retention_id,
        rookieRacerId: vote.rookie_retention_id,
      },
    ]));
    const retentionOptions = Object.fromEntries(teams.map((team) => {
      const roster = readDraftRetentionRoster.all(team.id).map(publicRacer);
      const priorSeasonRookieSource = rookieSource(season - 1);
      return [team.id, {
        veterans: roster.filter((racer) => racer.source !== priorSeasonRookieSource),
        rookies: roster.filter((racer) => racer.source === priorSeasonRookieSource),
        selected: retentionByTeam[team.id] || null,
      }];
    }));
    const initiation = {
      season,
      votes: initiationVotes,
      voteCount: initiationVotes.length,
      requiredVotes: teams.length,
      ready: initiationVotes.length >= teams.length,
      allTeamsAssigned: readManagerTeams.all().length >= teams.length,
      retentionRequired,
      retentionOptions,
    };
    if (!draft) return {
      status: "not_started", picks: [], pool: [], initiation,
    };
    const picks = readDraftPicks.all();
    const totalPicks = draft.rounds * teams.length;
    return {
      status: draft.status,
      rounds: draft.rounds,
      poolSize: draft.pool_size,
      startedAt: draft.started_at,
      completedAt: draft.completed_at,
      firstRaceAt: firstRaceAtForDraft(draft.started_at),
      picks,
      pool: readDraftPool.all().map(publicRacer),
      currentPick: picks.length < totalPicks ? picks.length + 1 : null,
      currentRound: picks.length < totalPicks
        ? Math.floor(picks.length / teams.length) + 1
        : null,
      order: openingDraftOrder(getActiveSeason()),
      initiation,
      currentTeamId: draft.status === "active"
        ? snakeTeamId(picks.length, openingDraftOrder(getActiveSeason()))
        : null,
    };
  }

  function draftVoteAlertIdsForSession(session = {}) {
    const keys = [];
    const draft = getDraft();
    if (draft.status === "not_started" && draft.initiation?.allTeamsAssigned) {
      keys.push(`opening:${draft.initiation.season}`);
    }
    const rookieDraft = getRookieDraft(getActiveSeason());
    if (rookieDraft.status === "voting") {
      keys.push(`rookie:${rookieDraft.season}`);
    }
    if (!session.username) return keys;
    const seen = new Set(readDraftVoteAlertReads.all(session.username).map((row) => row.alert_id));
    return keys.filter((key) => !seen.has(key));
  }

  function markDraftVoteAlertsSeen(username, alertIds = [], now = new Date()) {
    if (!username) return { unreadDraftVoteAlertIds: [] };
    const activeIds = new Set(draftVoteAlertIdsForSession({}));
    const seenAt = now.toISOString();
    for (const alertId of alertIds) {
      if (activeIds.has(alertId)) insertDraftVoteAlertRead.run(username, alertId, seenAt);
    }
    return { unreadDraftVoteAlertIds: draftVoteAlertIdsForSession({ username }) };
  }

  function getInitiationMartyr(season = 1) {
    const draft = readDraftState.get();
    if (
      draft?.status === "complete"
      && !readMartyrState.get(season)
      && countSeasonRaces.get(season).count === 0
    ) {
      insertMartyrState.run(season, draft.completed_at || new Date().toISOString());
    }
    const state = readMartyrState.get(season);
    if (!state) {
      return {
        season,
        status: draft?.status === "complete" ? "unavailable" : "not_started",
        candidates: [],
        votes: [],
        martyr: null,
      };
    }
    return {
      season,
      status: state.status,
      candidates: state.status === "voting"
        ? readDraftPool.all().map(publicRacer)
        : [],
      votes: readMartyrVotes.all(season),
      martyr: state.racer_id
        ? {
          id: state.racer_id,
          name: state.racer_name,
          pronouns: state.racer_pronouns,
        }
        : null,
    };
  }

  function getInMemoriam() {
    return readResolvedMartyrs.all().map((martyr) => ({
      racerId: martyr.racer_id,
      name: martyr.racer_name,
      pronouns: martyr.racer_pronouns,
      season: martyr.season,
      cause: `Initiation Martyr for Season ${martyr.season}`,
      diedAt: martyr.resolved_at,
    }));
  }

  function voteForInitiationMartyr(teamId, racerId, season = 1) {
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    const martyrState = getInitiationMartyr(season);
    if (martyrState.status !== "voting") {
      throw new Error("The Initiation Martyr vote is not active.");
    }
    if (martyrState.votes.some((vote) => vote.team_id === teamId)) {
      throw new Error("That team has already voted.");
    }
    if (!martyrState.candidates.some((racer) => racer.id === racerId)) {
      throw new Error("The sacrifice must be an unsigned racer from this draft.");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      insertMartyrVote.run(season, teamId, racerId, new Date().toISOString());
      const votes = readMartyrVotes.all(season);
      if (votes.length === teams.length) {
        const totals = new Map();
        for (const vote of votes) {
          totals.set(vote.racer_id, (totals.get(vote.racer_id) || 0) + 1);
        }
        const highestTotal = Math.max(...totals.values());
        const tied = [...totals.entries()]
          .filter(([, total]) => total === highestTotal)
          .map(([id]) => id)
          .sort();
        const draft = readDraftState.get();
        const random = seededRandom(hashText(
          `martyr:${season}:${draft.seed}:${votes.map((vote) => `${vote.team_id}:${vote.racer_id}`).sort().join("|")}`,
        ));
        const chosenId = tied[Math.floor(random() * tied.length)];
        resolveMartyr.run(chosenId, new Date().toISOString(), season);
        markRacerAsMartyr.run(chosenId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getInitiationMartyr(season);
  }

  function autoPickInitiationMartyr(season = getActiveSeason()) {
    const martyrState = getInitiationMartyr(season);
    if (martyrState.status !== "voting") {
      throw new Error("The Initiation Martyr vote is not active.");
    }
    if (!martyrState.candidates.length) {
      throw new Error("There are no eligible unsigned draft racers to martyr.");
    }
    const draft = readDraftState.get();
    const sortedCandidates = [...martyrState.candidates].sort((a, b) => a.id.localeCompare(b.id));
    const random = seededRandom(hashText(`stewards-martyr:${season}:${draft?.seed || ""}:${sortedCandidates.map((racer) => racer.id).join("|")}`));
    const chosen = sortedCandidates[Math.floor(random() * sortedCandidates.length)];
    const resolvedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      resolveMartyr.run(chosen.id, resolvedAt, season);
      markRacerAsMartyr.run(chosen.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getRaceCenter(season);
  }

  function rookieSource(season) {
    return `rookie-${season}`;
  }

  function openingDraftRoundsForSeason(season = getActiveSeason()) {
    return season > 1 ? 6 : 8;
  }

  function retentionOptionsForTeam(teamId, season = getActiveSeason()) {
    const roster = readDraftRetentionRoster.all(teamId);
    const priorSeasonRookieSource = rookieSource(season - 1);
    return {
      veterans: roster.filter((racer) => racer.source !== priorSeasonRookieSource),
      rookies: roster.filter((racer) => racer.source === priorSeasonRookieSource),
    };
  }

  function validateOpeningDraftRetention(teamId, veteranRetentionId, rookieRetentionId, season = getActiveSeason()) {
    if (season <= 1) return { veteranRetentionId: null, rookieRetentionId: null };
    const options = retentionOptionsForTeam(teamId, season);
    const veteran = options.veterans.find((racer) => racer.id === veteranRetentionId);
    const rookie = options.rookies.find((racer) => racer.id === rookieRetentionId);
    if (!veteranRetentionId || !rookieRetentionId) {
      throw new Error("Pick 1 veteran and 1 rookie to retain before voting.");
    }
    if (!veteran) throw new Error("That veteran is not eligible to be retained by your team.");
    if (!rookie) throw new Error("That rookie is not eligible to be retained by your team.");
    if (veteranRetentionId === rookieRetentionId) {
      throw new Error("Choose two different racers to retain.");
    }
    return { veteranRetentionId, rookieRetentionId };
  }

  function prepareOpeningDraftRosters(season = getActiveSeason()) {
    if (season <= 1) return;
    const votes = readDraftInitiationVotes.all(season);
    if (votes.length < teams.length) {
      throw new Error("All teams must select retainers before the opening draft can begin.");
    }
    for (const team of teams) {
      const vote = votes.find((item) => item.team_id === team.id);
      validateOpeningDraftRetention(
        team.id,
        vote?.veteran_retention_id,
        vote?.rookie_retention_id,
        season,
      );
      returnNonRetainedRosterToDraft.run(
        team.id,
        vote.veteran_retention_id,
        vote.rookie_retention_id,
      );
    }
  }

  function prepareFirstOpeningDraftPool() {
    if (
      getActiveSeason() !== 1
      || countSeasonRaces.get(1).count > 0
      || readDraftState.get()
    ) return;
    if (countStaleFirstDraftRacers.get().count > 0) {
      replaceUntouchedFirstDraftPool();
    } else {
      returnInitialRostersToFirstDraft.run();
      moveSeededFreeAgentsToFirstDraft.run();
    }
  }

  function rookieDraftOrder(season = 1) {
    const standings = calculateSeasonChampionships(
      readSeasonRacesForChampionship.all(season),
    ).teams;
    const reverseStandings = [...standings].reverse().map((standing) => standing.teamId);
    return [...reverseStandings, ...[...reverseStandings].reverse()];
  }

  function startRookieDraft(season = 1, now = new Date()) {
    if (readRookieDraftState.get(season)) return;
    const racesRun = countSeasonRaces.get(season).count;
    if (racesRun < 10) return;
    const seed = hashText(`rookie-draft:${season}:${racesRun}`);
    const random = seededRandom(seed);
    const names = generateRacerNames(24, seed, readAllRacerNames.all().map((row) => row.name));
    const order = rookieDraftOrder(season);
    const startedAt = now.toISOString();
    const notes = [
      "Still has the new-helmet smell.",
      "Claims every braking zone is merely a suggestion.",
      "Was discovered racing a storm drain.",
      "Keeps a rookie card of themselves in the glovebox.",
      "Has practiced this exact moment in several dreams.",
      "Recently learned what a chicane is and remains furious.",
    ];

    database.exec("BEGIN IMMEDIATE");
    try {
      insertRookieDraftState.run(
        season,
        seed,
        JSON.stringify(order),
        startedAt,
      );
      names.forEach((name, index) => {
        const rating = () => 3 + Math.floor(random() * 5);
        insertOrReactivateGeneratedRacer(
          `rookie-${season}-${seed}-${index + 1}`,
          name,
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          4 + Math.floor(random() * 3),
          notes[Math.floor(random() * notes.length)],
          pronounsForRacer(`rookie-${season}-${seed}-${index + 1}`),
          null,
          rookieSource(season),
        );
      });
      database.exec("COMMIT");
      ensureGrowthRows();
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function repairEmptyRookieDraftPool(season, state) {
    if (!state || state.status !== "active") return;
    if (readRookieDraftPicks.all(season).length) return;
    const currentPoolSize = readRookieDraftPool.all(rookieSource(season), season).length;
    if (currentPoolSize >= 24) return;
    const seed = state.seed;
    const random = seededRandom(seed);
    const names = generateRacerNames(24, seed, readAllRacerNames.all().map((row) => row.name));
    const notes = [
      "Still has the new-helmet smell.",
      "Claims every braking zone is merely a suggestion.",
      "Was discovered racing a storm drain.",
      "Keeps a rookie card of themselves in the glovebox.",
      "Has practiced this exact moment in several dreams.",
      "Recently learned what a chicane is and remains furious.",
    ];
    database.exec("BEGIN IMMEDIATE");
    try {
      names.forEach((name, index) => {
        const racerId = `rookie-${season}-${seed}-${index + 1}`;
        const rating = () => 3 + Math.floor(random() * 5);
        insertOrReactivateGeneratedRacer(
          racerId,
          name,
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          4 + Math.floor(random() * 3),
          notes[Math.floor(random() * notes.length)],
          pronounsForRacer(racerId),
          null,
          rookieSource(season),
        );
      });
      let repairedPoolSize = readRookieDraftPool.all(rookieSource(season), season).length;
      let replacementIndex = 1;
      while (repairedPoolSize < 24) {
        const racerId = `rookie-${season}-${seed}-replacement-${replacementIndex}`;
        const rating = () => 3 + Math.floor(random() * 5);
        insertOrReactivateGeneratedRacer(
          racerId,
          generateRacerNames(1, hashText(`${seed}:replacement:${replacementIndex}`), readAllRacerNames.all().map((row) => row.name))[0],
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          4 + Math.floor(random() * 3),
          notes[Math.floor(random() * notes.length)],
          pronounsForRacer(racerId),
          null,
          rookieSource(season),
        );
        replacementIndex += 1;
        repairedPoolSize = readRookieDraftPool.all(rookieSource(season), season).length;
      }
      database.exec("COMMIT");
      ensureGrowthRows();
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function recordRookiePick(racerId, automatic, season, now) {
    const state = readRookieDraftState.get(season);
    if (!state || state.status !== "active") {
      throw new Error("There is no active rookie draft.");
    }
    const order = JSON.parse(state.order_json);
    const teamId = order[state.current_pick - 1];
    const candidate = readRookieDraftPool.all(rookieSource(season), season)
      .find((racer) => racer.id === racerId);
    if (!candidate) throw new Error("That rookie is not available.");
    const pickedAt = now.toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      insertRookieDraftPick.run(
        season,
        state.current_pick,
        Math.floor((state.current_pick - 1) / teams.length) + 1,
        teamId,
        racerId,
        automatic ? 1 : 0,
        pickedAt,
      );
      assignRacer.run(teamId, racerId);
      if (state.current_pick >= order.length) {
        beginRookieReleases.run(season);
      } else {
        const nextDeadlineBase = automatic && state.pick_deadline
          ? new Date(state.pick_deadline)
          : now;
        advanceRookieDraft.run(
          state.current_pick + 1,
          new Date(nextDeadlineBase.getTime() + 12 * 60 * 60 * 1000).toISOString(),
          season,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function processRookieAutopick(season = 1, now = new Date()) {
    const state = readRookieDraftState.get(season);
    if (
      !state
      || state.status !== "active"
      || !state.pick_deadline
      || now.getTime() < new Date(state.pick_deadline).getTime()
    ) return;
    const best = readRookieDraftPool.all(rookieSource(season), season)
      .sort((a, b) => (
        b.pace - a.pace
        || b.control - a.control
        || b.potential - a.potential
        || a.name.localeCompare(b.name)
      ))[0];
    if (best) recordRookiePick(best.id, true, season, now);
  }

  function getRookieDraft(season = 1, now = new Date()) {
    const racesRun = countSeasonRaces.get(season).count;
    if (racesRun >= 10 && racesRun < SEASON_RACES) {
      startRookieDraft(season, now);
    }
    processRookieAutopick(season, now);
    const state = readRookieDraftState.get(season);
    if (!state) {
      return {
        season,
        status: "not_started",
        pool: [],
        picks: [],
        releases: [],
      };
    }
    repairEmptyRookieDraftPool(season, state);
    const order = JSON.parse(state.order_json);
    const releases = readRookieReleases.all(season);
    const initiationVotes = readRookieDraftInitiationVotes.all(season);
    const initiation = {
      season,
      votes: initiationVotes,
      voteCount: initiationVotes.length,
      requiredVotes: teams.length,
      ready: initiationVotes.length >= teams.length,
      allTeamsAssigned: readManagerTeams.all().length >= teams.length,
    };
    return {
      season,
      status: state.status,
      pool: readRookieDraftPool.all(rookieSource(season), season).map(publicRacer),
      picks: readRookieDraftPicks.all(season),
      releases,
      order,
      currentPick: state.status === "active" ? state.current_pick : null,
      currentRound: state.status === "active"
        ? Math.floor((state.current_pick - 1) / teams.length) + 1
        : null,
      currentTeamId: state.status === "active" ? order[state.current_pick - 1] : null,
      pickDeadline: state.pick_deadline,
      initiation,
      teamsAwaitingRelease: state.status === "releases"
        ? teams.filter((team) => !releases.some((release) => release.team_id === team.id))
          .map((team) => team.id)
        : [],
    };
  }

  function voteToStartRookieDraft({ teamId, leagueCode, season = getActiveSeason(), now = new Date() } = {}) {
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    if (String(leagueCode || "").trim().toLocaleLowerCase() !== LEAGUE_CODE) {
      throw new Error("That league code does not match this league.");
    }
    if (readManagerTeams.all().length < teams.length) {
      throw new Error("Waiting for all teams to be assigned before the rookie draft can begin.");
    }
    const racesRun = countSeasonRaces.get(season).count;
    if (racesRun < 10) throw new Error("Race 10 must be completed before the rookie draft can begin.");
    startRookieDraft(season, now);
    const state = readRookieDraftState.get(season);
    if (!state) throw new Error("The rookie class is not ready.");
    if (state.status !== "voting") return getRookieDraft(season, now);
    insertRookieDraftInitiationVote.run(season, teamId, now.toISOString());
    if (readRookieDraftInitiationVotes.all(season).length >= teams.length) {
      activateRookieDraftState.run(
        new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
        season,
      );
    }
    return getRookieDraft(season, now);
  }

  function makeRookieDraftPick(racerId, season = 1, now = new Date()) {
    processRookieAutopick(season, now);
    recordRookiePick(String(racerId), false, season, now);
    return getRookieDraft(season, now);
  }

  function releaseRacerAfterRookieDraft(teamId, racerId, season = 1, now = new Date()) {
    const draft = getRookieDraft(season, now);
    if (draft.status !== "releases") {
      throw new Error("The rookie draft is not awaiting roster releases.");
    }
    if (!draft.teamsAwaitingRelease.includes(teamId)) {
      throw new Error("That team has already released a racer.");
    }
    const racer = findRosterRacer.get(String(racerId));
    if (!racer || racer.team_id !== teamId) {
      throw new Error("That racer is not on this team's roster.");
    }
    if (racer.source === rookieSource(season)) {
      throw new Error("Newly signed rookies are not eligible to be released after the rookie draft.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      insertRookieRelease.run(season, teamId, racer.id, now.toISOString());
      assignRacer.run(null, racer.id);
      const replacement = readRoster.all(teamId)[0];
      if (replacement) replaceRelayDriver.run(replacement.id, teamId, racer.id);
      repairTeamRelayPlan(teamId);
      if (readRookieReleases.all(season).length === teams.length) {
        completeRookieDraft.run(now.toISOString(), season);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getRookieDraft(season, now);
  }

  function autoReleaseCandidate(teamId, season) {
    const currentRookieSource = rookieSource(season);
    const roster = readRoster.all(teamId);
    const candidates = roster.filter((racer) => racer.source !== currentRookieSource);
    const pool = candidates.length ? candidates : roster;
    return pool.sort((a, b) => (
      (a.pace + a.control + a.overtaking + a.stamina + a.technical + a.weird + a.potential)
      - (b.pace + b.control + b.overtaking + b.stamina + b.technical + b.weird + b.potential)
      || a.pace - b.pace
      || a.control - b.control
      || a.potential - b.potential
      || a.name.localeCompare(b.name)
    ))[0];
  }

  function autoCompleteRookieReleases(season = getActiveSeason(), now = new Date()) {
    let draft = getRookieDraft(season, now);
    if (draft.status !== "releases") {
      throw new Error("The rookie draft is not awaiting roster releases.");
    }
    for (const teamId of draft.teamsAwaitingRelease) {
      const release = autoReleaseCandidate(teamId, season);
      if (!release) throw new Error(`No releasable racer found for ${teamId}.`);
      draft = releaseRacerAfterRookieDraft(teamId, release.id, season, now);
    }
    return getRaceCenter(season);
  }

  function maintainRookieDraft(season = getActiveSeason(), now = new Date()) {
    const racesRun = countSeasonRaces.get(season).count;
    if (racesRun < 10 || racesRun >= SEASON_RACES) {
      return getRookieDraft(season, now);
    }
    let previousPick = null;
    let current = readRookieDraftState.get(season);
    while (current?.status === "active" && current.current_pick !== previousPick) {
      previousPick = current.current_pick;
      processRookieAutopick(season, now);
      current = readRookieDraftState.get(season);
    }
    return getRookieDraft(season, now);
  }

  function startDraft({ rounds, poolSize = 60, seed = Date.now() } = {}) {
    if (readDraftState.get()) throw new Error("A draft already exists.");
    const season = getActiveSeason();
    const draftRounds = season > 1
      ? openingDraftRoundsForSeason(season)
      : Number.isInteger(rounds)
      ? rounds
      : openingDraftRoundsForSeason(season);
    if (!Number.isInteger(draftRounds) || draftRounds < 6 || draftRounds > 12) {
      throw new Error("Draft rounds must be between 6 and 12.");
    }
    if (!Number.isInteger(poolSize) || poolSize < draftRounds * teams.length) {
      throw new Error("The draft pool must contain at least one racer per pick.");
    }

    const notes = [
      "Keeps a spare horizon in the glovebox.",
      "Has never lost an argument with a hairpin.",
      "Claims the racing line appeared in a dream.",
      "Can identify engines by their favorite weather.",
      "Carries an emergency duplicate of the moon.",
      "Refuses to acknowledge conventional braking zones.",
    ];

    database.exec("BEGIN IMMEDIATE");
    try {
      prepareFirstOpeningDraftPool();
      prepareOpeningDraftRosters(season);
      let returningRacerCount = countDraftPoolRacers.get().count;
      if (season === 1 && returningRacerCount > poolSize) {
        trimDraftPoolRacers.run(returningRacerCount - poolSize);
        returningRacerCount = countDraftPoolRacers.get().count;
      }
      if (returningRacerCount > poolSize) {
        throw new Error("The returning roster is larger than the opening draft pool.");
      }
      const newRacerCount = poolSize - returningRacerCount;
      const reservedNames = readAllRacerNames.all().map((row) => row.name);
      const names = generateRacerNames(newRacerCount, Number(seed), reservedNames);
      const random = seededRandom(Number(seed));
      insertDraftState.run(draftRounds, poolSize, Number(seed), new Date().toISOString());
      names.forEach((name, index) => {
        const rating = () => 4 + Math.floor(random() * 6);
        const racerId = `draft-${season}-${Number(seed)}-${index + 1}`;
        insertOrReactivateGeneratedRacer(
          racerId,
          name,
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          rating(),
          1 + Math.floor(random() * 5),
          notes[Math.floor(random() * notes.length)],
          pronounsForRacer(racerId),
          null,
          "draft",
        );
      });
      ensureGrowthRows();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getDraft();
  }

  function voteToStartDraft({
    teamId,
    leagueCode,
    rounds,
    poolSize = 60,
    seed = Date.now(),
    veteranRetentionId,
    rookieRetentionId,
  } = {}) {
    if (readDraftState.get()) return getDraft();
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    if (String(leagueCode || "").trim().toLocaleLowerCase() !== LEAGUE_CODE) {
      throw new Error("That league code does not match this league.");
    }
    if (readManagerTeams.all().length < teams.length) {
      throw new Error("Waiting for all teams to be assigned before the season can be initiated.");
    }
    const season = getActiveSeason();
    const retention = validateOpeningDraftRetention(
      teamId,
      veteranRetentionId,
      rookieRetentionId,
      season,
    );
    insertDraftInitiationVote.run(
      season,
      teamId,
      new Date().toISOString(),
      retention.veteranRetentionId,
      retention.rookieRetentionId,
    );
    if (readDraftInitiationVotes.all(season).length >= teams.length) {
      return startDraft({
        rounds: Number.isInteger(rounds) ? rounds : openingDraftRoundsForSeason(season),
        poolSize,
        seed,
      });
    }
    return getDraft();
  }

  function makeDraftPick(racerId) {
    const draft = readDraftState.get();
    if (!draft || draft.status !== "active") throw new Error("There is no active draft.");
    if (!findDraftRacer.get(racerId)) throw new Error("That racer is not available.");

    const picks = readDraftPicks.all();
    const totalPicks = draft.rounds * teams.length;
    if (picks.length >= totalPicks) throw new Error("The draft is already complete.");
    const pickNumber = picks.length + 1;
    const teamId = snakeTeamId(picks.length, openingDraftOrder(getActiveSeason()));

    database.exec("BEGIN");
    try {
      insertDraftPick.run(
        pickNumber,
        Math.floor(picks.length / teams.length) + 1,
        teamId,
        racerId,
        new Date().toISOString(),
      );
      if (pickNumber === totalPicks) {
        if (getActiveSeason() === 1) clearRosters.run();
        for (const team of teams) {
          const selected = pickedRacersForTeam.all(team.id);
          selected.forEach((row) => assignRacer.run(team.id, row.racer_id));
          clearTeamStints.run(team.id);
          readRoster.all(team.id).slice(0, 6).forEach((row, slot) => {
            insertStint.run(team.id, Math.floor(slot / 3), slot % 3, row.id, 20);
          });
        }
        completeDraft.run(new Date().toISOString());
        insertMartyrState.run(getActiveSeason(), new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getDraft();
  }

  function bestDraftPickCandidate(pool) {
    return [...pool].sort((a, b) => (
      b.pace - a.pace
      || b.control - a.control
      || b.potential - a.potential
      || a.name.localeCompare(b.name)
    ))[0];
  }

  function autoPickCurrentDraft() {
    const now = new Date();
    const openingDraft = readDraftState.get();
    if (openingDraft?.status === "active") {
      let draft = getDraft();
      while (draft.status === "active") {
        const best = bestDraftPickCandidate(draft.pool);
        if (!best) throw new Error("There are no available racers to auto-pick.");
        draft = makeDraftPick(best.id);
      }
      return getRaceCenter(getActiveSeason());
    }

    const season = getActiveSeason();
    const rookieDraft = readRookieDraftState.get(season);
    if (rookieDraft?.status === "active") {
      let draft = getRookieDraft(season, now);
      while (draft.status === "active") {
        const best = bestDraftPickCandidate(draft.pool);
        if (!best) throw new Error("There are no available rookies to auto-pick.");
        recordRookiePick(best.id, true, season, now);
        draft = getRookieDraft(season, now);
      }
      return getRaceCenter(season);
    }

    throw new Error("There is no active draft to auto-pick.");
  }

  function skipOpeningDraftAndMartyr() {
    const season = getActiveSeason();
    if (countSeasonRaces.get(season).count > 0) {
      throw new Error("The opening draft can only be skipped before the season's first race.");
    }
    let draft = readDraftState.get();
    if (!draft) {
      startDraft();
      draft = readDraftState.get();
    }
    if (draft.status === "active") {
      let draftState = getDraft();
      while (draftState.status === "active") {
        const best = bestDraftPickCandidate(draftState.pool);
        if (!best) throw new Error("There are no available racers to auto-pick.");
        draftState = makeDraftPick(best.id);
      }
    }
    const martyrState = getInitiationMartyr(season);
    if (martyrState.status === "voting") autoPickInitiationMartyr(season);
    return getRaceCenter(season);
  }

  function tradeAlertIdsForTeam(offers, teamId) {
    if (!teamId) return [];
    return offers.flatMap((offer) => {
      if (offer.status === "pending" && offer.receiving_team_id === teamId) {
        return [`incoming:${teamId}:${offer.id}`];
      }
      if (offer.status !== "pending" && offer.offering_team_id === teamId) {
        return [`resolved:${teamId}:${offer.id}:${offer.status}:${offer.resolved_at || ""}`];
      }
      return [];
    });
  }

  function unreadTradeAlertIds(username, teamId, offers = readTradeOffers.all()) {
    const seen = new Set(readTradeAlertReads.all(username).map((row) => row.alert_id));
    return tradeAlertIdsForTeam(offers, teamId).filter((id) => !seen.has(id));
  }

  function markTradeAlertsSeen(username, teamId, now = new Date()) {
    if (!username || !teamId) return getTransactions({ username, teamId });
    const offers = readTradeOffers.all();
    const seenAt = now.toISOString();
    for (const alertId of tradeAlertIdsForTeam(offers, teamId)) {
      insertTradeAlertRead.run(username, alertId, seenAt);
    }
    return getTransactions({ username, teamId });
  }

  function getTransactions(session = {}) {
    const draft = readDraftState.get();
    const offers = readTradeOffers.all();
    return {
      freeAgents: draft?.status === "active"
        ? readNonDraftFreeAgents.all()
        : readAllFreeAgents.all(),
      offers,
      history: readTransactions.all(),
      unreadTradeAlertIds: unreadTradeAlertIds(session.username, session.teamId, offers),
    };
  }

  function average(values) {
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function formatPerformanceValue(value) {
    return value === null || Number.isNaN(value) ? null : Number(value.toFixed(3));
  }

  function buildLapPerformanceSummaries() {
    const rows = readCompletedRaceLaps.all();
    const leagueCourseRole = new Map();
    const racerRows = new Map();
    for (const row of rows) {
      const leagueKey = `${row.course_name}:${row.role}`;
      const leagueValues = leagueCourseRole.get(leagueKey) || [];
      leagueValues.push(row.lap_time);
      leagueCourseRole.set(leagueKey, leagueValues);

      const racerValues = racerRows.get(row.racer_id) || [];
      racerValues.push(row);
      racerRows.set(row.racer_id, racerValues);
    }

    const courseRoleMedians = {};
    for (const course of COURSES) {
      courseRoleMedians[course.name] = {};
      for (const role of Object.keys(ROLE_CODES)) {
        courseRoleMedians[course.name][role] = formatPerformanceValue(
          median(leagueCourseRole.get(`${course.name}:${role}`) || []),
        );
      }
    }

    const byRacer = new Map();
    for (const [racerId, racerLapRows] of racerRows) {
      const courses = {};
      const roles = {};
      const vsCourseRole = {};
      const counts = {
        total: racerLapRows.length,
        courses: {},
        roles: {},
        vsCourseRole: {},
      };

      for (const course of COURSES) {
        const courseRows = racerLapRows.filter((row) => row.course_name === course.name);
        courses[`ALC-${COURSE_CODES[course.name]}`] = formatPerformanceValue(
          average(courseRows.map((row) => row.lap_time)),
        );
        counts.courses[`ALC-${COURSE_CODES[course.name]}`] = courseRows.length;
      }
      for (const role of Object.keys(ROLE_CODES)) {
        const roleRows = racerLapRows.filter((row) => row.role === role);
        roles[`ALR-${ROLE_CODES[role]}`] = formatPerformanceValue(
          average(roleRows.map((row) => row.lap_time)),
        );
        counts.roles[`ALR-${ROLE_CODES[role]}`] = roleRows.length;
      }
      for (const course of COURSES) {
        for (const role of Object.keys(ROLE_CODES)) {
          const code = `V${COURSE_CODES[course.name]}${ROLE_CODES[role]}`;
          const rowsForMatch = racerLapRows.filter((row) => (
            row.course_name === course.name && row.role === role
          ));
          const racerAverage = average(rowsForMatch.map((row) => row.lap_time));
          const leagueMedian = courseRoleMedians[course.name][role];
          vsCourseRole[code] = racerAverage === null || leagueMedian === null
            ? null
            : formatPerformanceValue(racerAverage - leagueMedian);
          counts.vsCourseRole[code] = rowsForMatch.length;
        }
      }

      byRacer.set(racerId, {
        ALT: formatPerformanceValue(average(racerLapRows.map((row) => row.lap_time))),
        courses,
        roles,
        vsCourseRole,
        counts,
      });
    }

    return { byRacer, courseRoleMedians };
  }

  function buildMostRecentRaceSummaries(season = getActiveSeason()) {
    const row = readLatestCompletedSeasonRace.get(season);
    if (!row) return new Map();
    const race = publicRace(row);
    const entriesById = new Map((race.entries || []).map((entry) => [entry.id, entry]));
    const recentByRacer = new Map();
    const ensureRecent = (racer) => {
      if (!racer?.id) return null;
      if (!recentByRacer.has(racer.id)) {
        recentByRacer.set(racer.id, {
          raceId: race.id,
          season: race.season,
          week: race.week,
          raceNumber: race.raceNumber,
          courseName: race.courseName,
          mishaps: 0,
          overtakeParticipations: 0,
          successfulOvertakeAttacks: 0,
          successfulOvertakeDefends: 0,
          firstFiveLapAverage: null,
          lastFiveLapAverage: null,
          role: null,
        });
      }
      return recentByRacer.get(racer.id);
    };

    for (const event of race.events || []) {
      if (event.type === "incident") {
        const entry = entriesById.get(event.entryId);
        const racer = entryDriverAtLap(entry, event.lap);
        const recent = ensureRecent(racer);
        if (recent) recent.mishaps += 1;
      }
      if (event.type === "overtake" || event.type === "overtake-denied") {
        const attackingEntry = entriesById.get(event.entryId);
        const defendingEntry = entriesById.get(event.relatedEntryId);
        const attacker = entryDriverAtLap(attackingEntry, event.lap);
        const defender = entryDriverAtLap(defendingEntry, event.lap);
        const attackerRecent = ensureRecent(attacker);
        const defenderRecent = ensureRecent(defender);
        if (attackerRecent) attackerRecent.overtakeParticipations += 1;
        if (defenderRecent) defenderRecent.overtakeParticipations += 1;
        if (event.type === "overtake" && attackerRecent) {
          attackerRecent.successfulOvertakeAttacks += 1;
        }
        if (event.type === "overtake-denied" && defenderRecent) {
          defenderRecent.successfulOvertakeDefends += 1;
        }
      }
    }

    const lapsByRacer = new Map();
    for (const lap of readRaceLapsForRace.all(race.id)) {
      const laps = lapsByRacer.get(lap.racer_id) || [];
      laps.push(lap);
      lapsByRacer.set(lap.racer_id, laps);
    }
    for (const [racerId, laps] of lapsByRacer) {
      const recent = ensureRecent({ id: racerId });
      const ordered = [...laps].sort((a, b) => a.lap - b.lap);
      recent.firstFiveLapAverage = formatPerformanceValue(
        average(ordered.slice(0, 5).map((lap) => lap.lap_time)),
      );
      recent.lastFiveLapAverage = formatPerformanceValue(
        average(ordered.slice(-5).map((lap) => lap.lap_time)),
      );
      recent.role = ordered[0]?.role || null;
    }

    return recentByRacer;
  }

  function getRacerDirectory() {
    const careerByRacer = new Map();
    const performance = buildLapPerformanceSummaries();
    const recentRaceByRacer = buildMostRecentRaceSummaries();
    const activeRaceId = readRuntime.get().active_race_id;
    const allCareerRaces = readAllRacesForCareer.all()
      .filter((race) => race.id !== activeRaceId);
    const mvdWinsByRacer = new Map();
    const racesBySeason = new Map();
    for (const raceRow of allCareerRaces) {
      const seasonRaces = racesBySeason.get(raceRow.season) || [];
      seasonRaces.push(raceRow);
      racesBySeason.set(raceRow.season, seasonRaces);
    }
    for (const seasonRaces of racesBySeason.values()) {
      if (seasonRaces.length < SEASON_RACES) continue;
      for (const standing of calculateSeasonChampionships(seasonRaces).mvds) {
        if (standing.rank !== 1) break;
        mvdWinsByRacer.set(
          standing.racerId,
          (mvdWinsByRacer.get(standing.racerId) || 0) + 1,
        );
      }
    }

    for (const raceRow of allCareerRaces) {
      const entries = JSON.parse(raceRow.entries_json);
      const standings = JSON.parse(raceRow.standings_json);
      const positionByEntry = new Map(
        standings.map((standing) => [standing.id, standing.position]),
      );
      const raceStats = new Map();
      for (const entry of entries) {
        const position = positionByEntry.get(entry.id);
        for (const stint of entry.stints) {
          const racerId = stint.driver.id;
          const stats = raceStats.get(racerId) || {
            laps: 0,
            bestFinish: null,
            won: false,
            podium: false,
          };
          stats.laps += stint.end - stint.start + 1;
          stats.bestFinish = Math.min(stats.bestFinish ?? Infinity, position);
          stats.won ||= position === 1;
          stats.podium ||= position <= 3;
          raceStats.set(racerId, stats);
        }
      }
      for (const [racerId, raceStatsForRacer] of raceStats) {
        const career = careerByRacer.get(racerId) || {
          races: 0,
          laps: 0,
          wins: 0,
          podiums: 0,
          bestFinish: null,
          mvds: 0,
        };
        career.races += 1;
        career.laps += raceStatsForRacer.laps;
        career.wins += Number(raceStatsForRacer.won);
        career.podiums += Number(raceStatsForRacer.podium);
        career.bestFinish = Math.min(
          career.bestFinish ?? Infinity,
          raceStatsForRacer.bestFinish,
        );
        career.mvds = mvdWinsByRacer.get(racerId) || 0;
        careerByRacer.set(racerId, career);
      }
    }

    const withCareer = (racer) => ({
      ...publicRacer(racer),
      career: careerByRacer.get(racer.id) || {
        races: 0,
        laps: 0,
        wins: 0,
        podiums: 0,
        bestFinish: null,
        mvds: mvdWinsByRacer.get(racer.id) || 0,
      },
      performance: performance.byRacer.get(racer.id) || {
        ALT: null,
        courses: {},
        roles: {},
        vsCourseRole: {},
        counts: { total: 0, courses: {}, roles: {}, vsCourseRole: {} },
      },
      recentRace: recentRaceByRacer.get(racer.id) || null,
    });
    const draft = readDraftState.get();
    const freeAgents = draft?.status === "active"
      ? readNonDraftFreeAgents.all()
      : readFreeAgentDirectory.all();
    return {
      signed: readSignedRacers.all().map(withCareer),
      freeAgents: freeAgents.map(withCareer),
    };
  }

  function proposeTrade(input) {
    const offeringTeamId = String(input.offeringTeamId);
    const receivingTeamId = String(input.receivingTeamId);
    if (offeringTeamId === receivingTeamId) throw new Error("A team cannot trade with itself.");
    if (!teams.some((team) => team.id === offeringTeamId)
      || !teams.some((team) => team.id === receivingTeamId)) {
      throw new Error("Unknown team.");
    }
    const offered = findRosterRacer.get(String(input.offeredRacerId));
    const requested = findRosterRacer.get(String(input.requestedRacerId));
    if (offered?.team_id !== offeringTeamId) {
      throw new Error("The offered racer is not on the offering team.");
    }
    if (requested?.team_id !== receivingTeamId) {
      throw new Error("The requested racer is not on the receiving team.");
    }
    const result = insertTradeOffer.run(
      offeringTeamId,
      receivingTeamId,
      offered.id,
      requested.id,
      new Date().toISOString(),
    );
    return readTradeOffer.get(result.lastInsertRowid);
  }

  function respondToTrade(offerId, action) {
    const offer = readTradeOffer.get(Number(offerId));
    if (!offer || offer.status !== "pending") throw new Error("That trade offer is no longer pending.");
    if (!["accept", "reject"].includes(action)) throw new Error("Unknown trade response.");

    if (action === "reject") {
      resolveTradeOffer.run("rejected", new Date().toISOString(), offer.id);
      return readTradeOffer.get(offer.id);
    }

    const offered = findRosterRacer.get(offer.offered_racer_id);
    const requested = findRosterRacer.get(offer.requested_racer_id);
    if (offered?.team_id !== offer.offering_team_id
      || requested?.team_id !== offer.receiving_team_id) {
      throw new Error("One of the racers has changed teams since this offer was made.");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      assignRacer.run(offer.receiving_team_id, offer.offered_racer_id);
      assignRacer.run(offer.offering_team_id, offer.requested_racer_id);
      replaceRelayDriver.run(
        offer.requested_racer_id,
        offer.offering_team_id,
        offer.offered_racer_id,
      );
      replaceRelayDriver.run(
        offer.offered_racer_id,
        offer.receiving_team_id,
        offer.requested_racer_id,
      );
      repairTeamRelayPlan(offer.offering_team_id);
      repairTeamRelayPlan(offer.receiving_team_id);
      resolveTradeOffer.run("accepted", new Date().toISOString(), offer.id);
      insertTransaction.run(
        "trade",
        offer.offering_team_id,
        offer.receiving_team_id,
        offer.requested_racer_id,
        offer.offered_racer_id,
        new Date().toISOString(),
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return readTradeOffer.get(offer.id);
  }

  function signFreeAgent(teamId, freeAgentId, releasedRacerId) {
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    const freeAgent = findRosterRacer.get(String(freeAgentId));
    const released = findRosterRacer.get(String(releasedRacerId));
    if (!freeAgent || freeAgent.team_id !== null || freeAgent.source === "martyr") {
      throw new Error("That racer is not a free agent.");
    }
    if (!released || released.team_id !== teamId) throw new Error("The released racer is not on that team.");

    database.exec("BEGIN IMMEDIATE");
    try {
      assignRacer.run(teamId, freeAgent.id);
      assignRacer.run(null, released.id);
      replaceRelayDriver.run(freeAgent.id, teamId, released.id);
      repairTeamRelayPlan(teamId);
      insertTransaction.run(
        "free_agent",
        teamId,
        null,
        freeAgent.id,
        released.id,
        new Date().toISOString(),
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { teamId, acquiredRacerId: freeAgent.id, releasedRacerId: released.id };
  }

  function getDevelopment(week = 1) {
    applyDueDevelopment();
    const upgradeWeek = ensureUpgradeWeek(week);
    const carUpgradeWeek = ensureCarUpgradeWeek(week);
    const eligibleRacerIdsByTeam = Object.fromEntries(teams.map((team) => [team.id, []]));
    for (const row of readEligibleRacers.all(week)) {
      eligibleRacerIdsByTeam[row.team_id]?.push(row.racer_id);
    }
    return {
      week: displayWeekForKey(week),
      options: [
        upgradeWeek.option_one,
        upgradeWeek.option_two,
        upgradeWeek.option_three,
      ],
      choices: readUpgradeChoices.all(week),
      carOptions: [
        carUpgradeWeek.option_one,
        carUpgradeWeek.option_two,
        carUpgradeWeek.option_three,
      ],
      carChoices: readCarUpgradeChoices.all(week),
      eligibleRacerIdsByTeam,
    };
  }

  function recordRaceParticipation(participants, week = 1) {
    if (!Array.isArray(participants) || !participants.length) {
      throw new Error("Race participation is required.");
    }

    const usedRacers = [];
    const seenRacerIds = new Set();
    for (const participant of participants) {
      const teamId = String(participant.teamId);
      if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
      if (!Array.isArray(participant.racerIds)) {
        throw new Error("Each team needs a list of participating racers.");
      }
      for (const racerIdValue of participant.racerIds) {
        const racerId = String(racerIdValue);
        if (seenRacerIds.has(racerId)) continue;
        const racer = findRosterRacer.get(racerId);
        if (!racer || racer.team_id !== teamId) {
          throw new Error("A participating racer is not on the listed team.");
        }
        seenRacerIds.add(racerId);
        usedRacers.push({ racerId, teamId });
      }
    }
    if (!usedRacers.length) throw new Error("At least one racer must participate.");

    database.exec("BEGIN IMMEDIATE");
    try {
      const usedAt = new Date().toISOString();
      for (const racer of usedRacers) {
        insertRaceParticipation.run(week, racer.racerId, racer.teamId, usedAt);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getDevelopment(week);
  }

  function publicRace(row) {
    if (!row) return null;
    const events = JSON.parse(row.events_json);
    const raceStart = events.find((event) => event.type === "race-start") || events[0];
    const race = {
      id: row.id,
      season: row.season,
      week: row.week,
      raceNumber: row.race_number,
      courseName: row.course_name,
      seed: row.seed,
      duration: row.duration,
      preRaceDuration: Math.max(0, -Math.min(...events.map((event) => event.time))),
      entries: JSON.parse(row.entries_json),
      events,
      condition: raceStart?.condition || "Sunny",
      course: raceStart?.course || null,
      finalStandings: JSON.parse(row.standings_json),
      createdAt: row.created_at,
      startAt: row.start_at || row.created_at,
    };
    race.recapText = row.recap_text || generateRaceRecap(race);
    return race;
  }

  function getRace(raceId) {
    const race = publicRace(readRace.get(Number(raceId)));
    if (!race) throw new Error("Unknown race.");
    return race;
  }

  function getSeasonHistory() {
    return readSeasonHistory.all().map((row) => ({
      season: row.season,
      teamStandings: JSON.parse(row.team_standings_json),
      mvdStandings: JSON.parse(row.mvd_standings_json),
      champions: JSON.parse(row.champions_json),
      openingDraft: row.opening_draft_json ? JSON.parse(row.opening_draft_json) : null,
      rookieDraft: row.rookie_draft_json ? JSON.parse(row.rookie_draft_json) : null,
      finalizedAt: row.finalized_at,
    }));
  }

  function openingDraftOrder(season = getActiveSeason()) {
    if (season <= 1) return teams.map((team) => team.id);
    const priorSeason = getSeasonHistory().find((entry) => entry.season === season - 1);
    if (!priorSeason) return teams.map((team) => team.id);
    return [...priorSeason.teamStandings]
      .sort((a, b) => b.rank - a.rank)
      .map((standing) => standing.teamId);
  }

  function finalizeSeasonHistory(season) {
    const seasonRaces = readSeasonRacesForChampionship.all(season);
    if (seasonRaces.length < SEASON_RACES) return;
    const standings = calculateSeasonChampionships(seasonRaces);
    insertSeasonHistory.run(
      season,
      JSON.stringify(standings.teams),
      JSON.stringify(standings.mvds),
      JSON.stringify({
        teams: standings.teams.filter((standing) => standing.rank === 1),
        mvds: standings.mvds.filter((standing) => standing.rank === 1),
      }),
      JSON.stringify(getDraft()),
      JSON.stringify(getRookieDraft(season)),
      new Date().toISOString(),
    );
  }

  function getRaceCenter(season = 1) {
    applyDueDevelopment();
    const seasonRacesRun = countSeasonRaces.get(season).count;
    const week = Math.min(WEEKS_PER_SEASON, Math.floor(seasonRacesRun / RACES_PER_WEEK) + 1);
    const racesRun = countWeekRaces.get(season, week).count;
    const activeRaceId = readRuntime.get().active_race_id;
    const completedAllRaces = readAllRacesForCareer.all()
      .filter((race) => race.id !== activeRaceId);
    const completedSeasonRaces = completedAllRaces
      .filter((race) => race.season === season);
    const seasonComplete = completedSeasonRaces.length >= SEASON_RACES;
    const nextRaceNumber = seasonComplete ? null : seasonRacesRun + 1;
    const trackName = TRACKS[week - 1];
    const forecastSeed = `season-${season}-week-${week}-race-${nextRaceNumber}`;
    const draft = readDraftState.get();
    const firstRaceAt = draft?.started_at
      ? firstRaceAtForDraft(draft.started_at)
      : null;
    const latestSeasonRace = readLatestSeasonRace.get(season);
    const seasonChampionships = calculateSeasonChampionships(
      completedSeasonRaces,
    );
    const lapPerformance = buildLapPerformanceSummaries();
    const forecastCondition = nextRaceNumber
      ? selectRaceCondition(trackName, forecastSeed)
      : null;
    let qualifierGrid = [];
    if (nextRaceNumber && draft?.status === "complete") {
      const league = getLeagueState();
      qualifierGrid = applyQualifierGrid(
        buildEntries(
          league.lineups,
          league.carNames,
          league.rosters,
          league.cars,
          Object.fromEntries(readBrands.all().map((brand) => [brand.team_id, brand])),
        ),
        seasonChampionships.teams,
        trackName,
        forecastCondition,
        forecastSeed,
      )
        .map((entry) => ({
          id: entry.id,
          carName: entry.carName,
          teamId: entry.teamId,
          color: entry.color,
          driver: entry.stints[0]?.driver?.name || "",
          gridPosition: entry.startingGridPosition,
          qualifierTime: entry.qualifier?.totalTime || 0,
          qualifierIncidents: entry.qualifier?.incidents || [],
          qualifierMishaps: (entry.qualifier?.incidents || [])
            .filter((incident) => incident.type === "mishap").length,
          qualifierSpins: (entry.qualifier?.incidents || [])
            .filter((incident) => incident.type === "spin").length,
          firstLapPenalty: entry.startingGridPenalty,
        }))
        .sort((a, b) => a.gridPosition - b.gridPosition);
    }
    return {
      season,
      week,
      weeksPerSeason: WEEKS_PER_SEASON,
      racesPerWeek: RACES_PER_WEEK,
      seasonRaces: SEASON_RACES,
      seasonRacesRun,
      racesRun,
      trackName,
      nextRaceNumber,
      nextRaceAt: nextRaceNumber && firstRaceAt
        ? latestSeasonRace
          ? nextWeekdayRaceAt(latestSeasonRace.start_at || latestSeasonRace.created_at)
          : nextAvailableRaceAt(firstRaceAt, 0)
        : null,
      forecastCondition,
      activeRaceId,
      raceActive: activeRaceId !== null,
      seasonComplete,
      races: readRaceSummaries.all().filter((race) => race.id !== activeRaceId),
      championship: seasonChampionships.teams,
      mvdStandings: seasonChampionships.mvds,
      teamChampionshipWins: calculateTeamChampionshipWins(completedAllRaces),
      lapPerformance: {
        courseRoleMedians: lapPerformance.courseRoleMedians,
      },
      champions: seasonComplete ? {
        teams: seasonChampionships.teams.filter((standing) => standing.rank === 1),
        mvds: seasonChampionships.mvds.filter((standing) => standing.rank === 1),
      } : null,
      qualifierGrid,
    };
  }

  function getActiveSeason() {
    return readRuntime.get().active_season;
  }

  function beginNextSeason() {
    const runtime = readRuntime.get();
    if (runtime.active_race_id !== null) {
      throw new Error("A new season cannot begin while a race is happening.");
    }
    const currentSeason = runtime.active_season;
    const currentCenter = getRaceCenter(currentSeason);
    if (!currentCenter.seasonComplete) {
      throw new Error("The current season must be completed before the next one begins.");
    }
    finalizeSeasonHistory(currentSeason);
    updateSeasonDraftHistory.run(
      JSON.stringify(getDraft()),
      JSON.stringify(getRookieDraft(currentSeason)),
      currentSeason,
    );
    const nextSeason = currentSeason + 1;

    database.exec("BEGIN IMMEDIATE");
    try {
      clearDraftPicks.run();
      clearDraftState.run();
      clearDraftInitiationVotes.run(nextSeason);
      graduateOpeningDraftClass.run();
      relegateFreeAgents.run();
      cancelPendingTrades.run(new Date().toISOString());
      setActiveSeason.run(nextSeason, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    ensureUpgradeWeek(seasonWeekKey(nextSeason, 1));
    ensureCarUpgradeWeek(seasonWeekKey(nextSeason, 1));
    return getRaceCenter(nextSeason);
  }

  function createRace({
    season = getActiveSeason(),
    condition: forcedCondition,
    seed: forcedSeed,
    startAt: scheduledStartAt,
  } = {}) {
    if (readRuntime.get().active_race_id !== null) {
      throw new Error("A league race is already happening.");
    }
    const seasonRacesRun = countSeasonRaces.get(season).count;
    if (seasonRacesRun >= SEASON_RACES) throw new Error("This season is complete.");
    const draft = readDraftState.get();
    if (
      season === getActiveSeason()
      && season > 1
      && seasonRacesRun === 0
      && draft?.status !== "complete"
    ) {
      throw new Error("The opening draft must be completed before Race 1.");
    }
    const martyrState = getInitiationMartyr(season);
    if (
      seasonRacesRun === 0
      && draft?.status === "complete"
      && martyrState.status !== "resolved"
    ) {
      throw new Error("The Stewards demand an Initiation Martyr before the first race.");
    }
    const rookieDraft = getRookieDraft(season);
    if (seasonRacesRun >= 10 && rookieDraft.status !== "complete") {
      throw new Error("The midseason rookie draft and roster releases must be completed before Race 11.");
    }
    const seasonRaceNumber = seasonRacesRun + 1;
    const week = Math.floor(seasonRacesRun / RACES_PER_WEEK) + 1;
    const raceNumber = countWeekRaces.get(season, week).count + 1;
    const developmentWeek = seasonWeekKey(season, week);
    applyDueDevelopment();

    const league = getLeagueState();
    const baseEntries = buildEntries(
      league.lineups,
      league.carNames,
      league.rosters,
      league.cars,
      Object.fromEntries(readBrands.all().map((brand) => [brand.team_id, brand])),
    );
    const courseName = TRACKS[week - 1];
    const forecastSeed = `season-${season}-week-${week}-race-${seasonRaceNumber}`;
    const condition = forcedCondition || selectRaceCondition(courseName, forecastSeed);
    const seed = forcedSeed || `season-${season}-week-${week}-race-${raceNumber}-${Date.now()}`;
    const entries = applyQualifierGrid(
      baseEntries,
      getRaceCenter(season).championship,
      courseName,
      condition,
      forecastSeed,
    );
    const race = simulateRace(entries, seed, { courseName, condition });
    const pole = [...entries].sort((a, b) => a.startingGridPosition - b.startingGridPosition)[0];
    if (pole) {
      race.events.push({
        time: -600,
        type: "qualifier",
        message: `Qualifier relays have been run by each team's cars, and ${pole.carName} will be in pole position.`,
        standings: race.events[0].standings,
        category: "event",
      });
      race.events.sort((a, b) => a.time - b.time);
    }
    if (seasonRacesRun === 0 && martyrState.status === "resolved") {
      const martyrName = martyrState.martyr.name;
      race.preRaceDuration = 60;
      race.events.push({
        time: -60,
        type: "martyr-ceremony",
        message: `Four figures in black robes and driving helmets lead ${martyrName} onto the black top. The aspirant driver kneels before them, hands together in prayer and trembling. The four figures draw pistols and say with voices that boom through the stands, "Speed godspeed." They then fire all at once, making mince meat out of ${martyrName}'s head. The corpse crumples to the ground, and the crowd goes wild!`,
        standings: race.events[0].standings,
        martyrId: martyrState.martyr.id,
      });
      race.events.sort((a, b) => a.time - b.time);
    }
    const createdAt = new Date().toISOString();
    const startAt = scheduledStartAt || createdAt;

    database.exec("BEGIN IMMEDIATE");
    try {
      const insertResult = insertRace.run(
        season,
        week,
        raceNumber,
        courseName,
        seed,
        race.duration,
        JSON.stringify(entries),
        JSON.stringify(race.events),
        JSON.stringify(race.finalStandings),
        createdAt,
        startAt,
      );
      const raceId = Number(insertResult.lastInsertRowid);
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));
      race.finalStandings.forEach((standing, index) => {
        const entry = entryById.get(standing.id);
        insertRaceResult.run(
          raceId,
          standing.id,
          entry.teamId,
          entry.carName,
          standing.position,
          standing.status === "dnf" ? 0 : RACE_POINTS[index] ?? 0,
        );
      });
      for (const lap of race.lapRecords || []) {
        insertRaceLap.run(
          raceId,
          season,
          week,
          raceNumber,
          courseName,
          lap.entryId,
          lap.teamId,
          lap.carName,
          lap.racerId,
          lap.racerName,
          lap.role,
          lap.lap,
          lap.lapTime,
        );
      }

      const usedAt = createdAt;
      for (const entry of entries) {
        for (const racerId of new Set(entry.stints.map((stint) => stint.driver.id))) {
          insertRaceParticipation.run(developmentWeek, racerId, entry.teamId, usedAt);
        }
      }
      setActiveRace.run(raceId, createdAt);
      database.exec("COMMIT");
      return getRace(raceId);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function raceDebutContext(race) {
    const debutRaceId = Number(race.id);
    const isFirstRaceOfSeason = race.week === 1 && race.raceNumber === 1;
    const rookies = [];
    const veterans = [];
    for (const racer of readRaceParticipantsForDebuts.all(debutRaceId)) {
      const careerRaceCount = countPriorCareerRacesForRacer.get(racer.racer_id, debutRaceId).count;
      const seasonRaceCount = countPriorSeasonRacesForRacer.get(
        racer.racer_id,
        race.season,
        debutRaceId,
      ).count;
      if (isRookieOrigin({ id: racer.racer_id, source: racer.source }) && careerRaceCount === 0) {
        rookies.push(racer.racer_name);
      } else if (!isFirstRaceOfSeason && seasonRaceCount === 0) {
        veterans.push(racer.racer_name);
      }
    }
    return {
      debuts: {
        rookies: [...new Set(rookies)].sort((a, b) => a.localeCompare(b)),
        veterans: [...new Set(veterans)].sort((a, b) => a.localeCompare(b)),
      },
    };
  }

  function finishRace(raceId) {
    const activeRaceId = readRuntime.get().active_race_id;
    if (activeRaceId === null) return getRaceCenter(getActiveSeason());
    if (activeRaceId !== Number(raceId)) throw new Error("That race is not currently active.");
    const race = getRace(raceId);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const event of race.events) {
        if (event.markGranted && event.racerId) grantSpeedMark.run(event.racerId);
      }
      updateRaceRecap.run(generateRaceRecap(race, raceDebutContext(race)), race.id);
      setActiveRace.run(null, new Date().toISOString());
      if (countSeasonRaces.get(race.season).count >= SEASON_RACES) {
        finalizeSeasonHistory(race.season);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getRaceCenter(getActiveSeason());
  }

  function finishActiveRaceNow() {
    const activeRaceId = readRuntime.get().active_race_id;
    if (activeRaceId === null) throw new Error("There is no active race to finish.");
    return finishRace(activeRaceId);
  }

  function fastForwardToRace10() {
    let center = getRaceCenter(getActiveSeason());
    if (center.seasonRacesRun >= 10) return center;
    if (center.raceActive) {
      center = finishActiveRaceNow();
    }
    while (center.seasonRacesRun < 10) {
      const race = createRace({
        season: getActiveSeason(),
        seed: `stewards-race-10-${getActiveSeason()}-${center.seasonRacesRun + 1}-${Date.now()}`,
      });
      center = finishRace(race.id);
    }
    return center;
  }

  function resetActiveSeasonRaces() {
    const season = getActiveSeason();
    const firstWeekKey = seasonWeekKey(season, 1);
    const lastWeekKey = seasonWeekKey(season, WEEKS_PER_SEASON);
    database.exec("BEGIN IMMEDIATE");
    try {
      setActiveRace.run(null, new Date().toISOString());
      deleteRaceResultsForSeason.run(season);
      deleteRacesForSeason.run(season);
      deleteRookieDraftPicksForSeason.run(season);
      deleteRookieDraftReleasesForSeason.run(season);
      deleteRookieDraftInitiationVotesForSeason.run(season);
      deleteRookieDraftStateForSeason.run(season);
      deleteMartyrVotesForSeason.run(season);
      deleteMartyrStateForSeason.run(season);
      deleteSeasonHistoryForSeason.run(season);
      deleteRaceParticipationForSeason.run(firstWeekKey, lastWeekKey);
      deleteUpgradeChoicesForSeason.run(firstWeekKey, lastWeekKey);
      deleteUpgradeWeeksForSeason.run(firstWeekKey, lastWeekKey);
      deleteCarUpgradeChoicesForSeason.run(firstWeekKey, lastWeekKey);
      deleteCarUpgradeWeeksForSeason.run(firstWeekKey, lastWeekKey);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    ensureUpgradeWeek(firstWeekKey);
    ensureCarUpgradeWeek(firstWeekKey);
    return getRaceCenter(season);
  }

  function restartActiveSeason() {
    const season = getActiveSeason();
    const firstWeekKey = seasonWeekKey(season, 1);
    const lastWeekKey = seasonWeekKey(season, WEEKS_PER_SEASON);
    database.exec("BEGIN IMMEDIATE");
    try {
      setActiveRace.run(null, new Date().toISOString());
      deleteRaceResultsForSeason.run(season);
      deleteRacesForSeason.run(season);
      deleteRookieDraftPicksForSeason.run(season);
      deleteRookieDraftReleasesForSeason.run(season);
      deleteRookieDraftInitiationVotesForSeason.run(season);
      deleteRookieDraftStateForSeason.run(season);
      deleteMartyrVotesForSeason.run(season);
      deleteMartyrStateForSeason.run(season);
      deleteSeasonHistoryForSeason.run(season);
      deleteRaceParticipationForSeason.run(firstWeekKey, lastWeekKey);
      deleteUpgradeChoicesForSeason.run(firstWeekKey, lastWeekKey);
      deleteUpgradeWeeksForSeason.run(firstWeekKey, lastWeekKey);
      deleteCarUpgradeChoicesForSeason.run(firstWeekKey, lastWeekKey);
      deleteCarUpgradeWeeksForSeason.run(firstWeekKey, lastWeekKey);
      clearDraftPicks.run();
      clearDraftState.run();
      clearDraftInitiationVotes.run(season);
      relegateFreeAgents.run();
      returnRostersToDraft.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    ensureUpgradeWeek(firstWeekKey);
    ensureCarUpgradeWeek(firstWeekKey);
    return getRaceCenter(season);
  }

  function chooseWeeklyUpgrade(teamId, racerId, optionIndex, week = 1) {
    const now = new Date();
    applyDueDevelopment(now);
    assertDevelopmentChoiceOpen(week, now);
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    const existingChoice = readTeamUpgradeChoice.get(week, teamId);
    if (existingChoice?.applied_at) {
      throw new Error("This team's weekly training has already been applied.");
    }
    const racer = findRosterRacer.get(racerId);
    if (!racer || racer.team_id !== teamId) {
      throw new Error("That racer is not on this team.");
    }
    if (!readRacerParticipation.get(week, racerId)) {
      throw new Error("Only racers who drove in a race this week can receive an upgrade.");
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 2) {
      throw new Error("Unknown weekly upgrade option.");
    }
    const upgradeWeek = ensureUpgradeWeek(week);
    const stat = [
      upgradeWeek.option_one,
      upgradeWeek.option_two,
      upgradeWeek.option_three,
    ][optionIndex];
    const growth = readGrowth.get(racerId, stat);
    if (!growth) throw new Error("Racer growth data is unavailable.");
    const result = growth.remaining > 0 ? "improved" : "capped";

    database.exec("BEGIN IMMEDIATE");
    try {
      insertUpgradeChoice.run(
        week,
        teamId,
        optionIndex,
        racerId,
        stat,
        result,
        new Date().toISOString(),
      );
      applyChoiceIfDue(week, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      week,
      teamId,
      racerId,
      stat,
      result,
      appliedAt: readTeamUpgradeChoice.get(week, teamId)?.applied_at || null,
      racer: publicRacer(readRoster.all(teamId).find((item) => item.id === racerId)),
    };
  }

  function chooseWeeklyCarUpgrade(teamId, carIndex, optionIndex, week = 1) {
    const now = new Date();
    applyDueDevelopment(now);
    assertDevelopmentChoiceOpen(week, now);
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    const existingChoice = readTeamCarUpgradeChoice.get(week, teamId);
    if (existingChoice?.applied_at) {
      throw new Error("This team's weekly car upgrade has already been applied.");
    }
    if (![0, 1].includes(carIndex) || !readCar.get(teamId, carIndex)) {
      throw new Error("Unknown car.");
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 2) {
      throw new Error("Unknown weekly car upgrade option.");
    }
    const upgradeWeek = ensureCarUpgradeWeek(week);
    const stat = [
      upgradeWeek.option_one,
      upgradeWeek.option_two,
      upgradeWeek.option_three,
    ][optionIndex];
    const car = readCar.get(teamId, carIndex);
    if (car[stat] >= 10) throw new Error(`That car's ${stat} is already at 10.`);

    database.exec("BEGIN IMMEDIATE");
    try {
      insertCarUpgradeChoice.run(
        week,
        teamId,
        optionIndex,
        carIndex,
        stat,
        new Date().toISOString(),
      );
      applyChoiceIfDue(week, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      week,
      teamId,
      carIndex,
      stat,
      appliedAt: readTeamCarUpgradeChoice.get(week, teamId)?.applied_at || null,
      car: readCar.get(teamId, carIndex),
    };
  }

  function publicMediaEntry(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      authorUsername: row.author_username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function normalizeMediaEntryInput(input = {}) {
    const title = String(input.title || "").trim();
    const body = String(input.body || "").trim();
    if (!title) throw new Error("Media entries need a title.");
    if (title.length > 140) throw new Error("Media entry titles must be 140 characters or fewer.");
    if (!body) throw new Error("Media entries need text.");
    if (body.length > 80_000) throw new Error("Media entry text is too long.");
    return { title, body };
  }

  function assertCanModifyMediaEntry(username, entry) {
    if (!entry) throw new Error("Unknown media entry.");
    if (username === STEWARD_USERNAME || entry.author_username === username) return;
    const error = new Error("Only the author can change this media entry.");
    error.statusCode = 403;
    throw error;
  }

  function getMediaEntries(username = "") {
    const entries = readMediaEntries.all().map(publicMediaEntry);
    const seen = new Set(readMediaEntryReads.all(username).map((row) => row.media_entry_id));
    return {
      entries,
      authorProfiles: username === STEWARD_USERNAME
        ? readManagerProfiles.all(STEWARD_USERNAME).map((manager) => ({
          username: manager.username,
          teamId: manager.team_id,
        }))
        : [],
      unreadEntryIds: entries
        .filter((entry) => entry.authorUsername !== username && !seen.has(entry.id))
        .map((entry) => entry.id),
    };
  }

  function createMediaEntry(username, input) {
    const { title, body } = normalizeMediaEntryInput(input);
    const requestedAuthor = String(input?.authorUsername || "").trim().toLocaleLowerCase();
    const authorUsername = username === STEWARD_USERNAME && requestedAuthor
      ? requestedAuthor
      : username;
    if (!readManager.get(authorUsername)) throw new Error("Unknown media author.");
    const now = new Date().toISOString();
    const result = insertMediaEntry.run(title, body, authorUsername, now, now);
    insertMediaEntryRead.run(authorUsername, result.lastInsertRowid, now);
    if (username !== authorUsername) insertMediaEntryRead.run(username, result.lastInsertRowid, now);
    return publicMediaEntry(readMediaEntry.get(result.lastInsertRowid));
  }

  function updateMediaEntry(username, id, input) {
    const entryId = Number(id);
    const entry = readMediaEntry.get(entryId);
    assertCanModifyMediaEntry(username, entry);
    const { title, body } = normalizeMediaEntryInput(input);
    updateMediaEntryRecord.run(title, body, new Date().toISOString(), entryId);
    return publicMediaEntry(readMediaEntry.get(entryId));
  }

  function deleteMediaEntry(username, id) {
    const entryId = Number(id);
    const entry = readMediaEntry.get(entryId);
    assertCanModifyMediaEntry(username, entry);
    deleteMediaEntryRecord.run(entryId);
    return { ok: true, id: entryId };
  }

  function markMediaEntrySeen(username, id) {
    const entryId = Number(id);
    if (!readMediaEntry.get(entryId)) throw new Error("Unknown media entry.");
    insertMediaEntryRead.run(username, entryId, new Date().toISOString());
    return getMediaEntries(username);
  }

  function registerManager({ username, password, leagueCode }) {
    if (String(leagueCode || "").trim().toLocaleLowerCase() !== LEAGUE_CODE) {
      throw new Error("That league code does not match this league.");
    }
    const normalizedUsername = normalizeUsername(username);
    if (normalizedUsername === STEWARD_USERNAME) {
      throw new Error("That username is reserved.");
    }
    const validatedPassword = validatePassword(password);
    if (readManager.get(normalizedUsername)) {
      throw new Error("That username is already registered.");
    }
    const teamId = nextAvailableManagerTeamId();
    if (!teamId) throw new Error("All teams currently assigned!");
    const salt = randomBytes(16).toString("hex");
    database.exec("BEGIN IMMEDIATE");
    try {
      insertManager.run(
        normalizedUsername,
        salt,
        hashPassword(validatedPassword, salt),
        teamId,
        new Date().toISOString(),
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { username: normalizedUsername, teamId };
  }

  function loginManager({ username, password }) {
    const normalizedUsername = normalizeUsername(username);
    const validatedPassword = validatePassword(password);
    const manager = readManager.get(normalizedUsername);
    if (!manager) throw new Error("Username or password did not match.");
    const attemptedHash = Buffer.from(hashPassword(validatedPassword, manager.password_salt), "hex");
    const storedHash = Buffer.from(manager.password_hash, "hex");
    if (
      attemptedHash.length !== storedHash.length
      || !timingSafeEqual(attemptedHash, storedHash)
    ) {
      throw new Error("Username or password did not match.");
    }
    return { username: manager.username, teamId: manager.team_id };
  }

  function createManagerSession(sessionId, manager) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    insertManagerSession.run(
      sessionId,
      manager.username,
      manager.teamId,
      now.toISOString(),
      expiresAt.toISOString(),
    );
    return {
      username: manager.username,
      teamId: manager.teamId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  function getManagerSession(sessionId) {
    deleteExpiredManagerSessions.run(new Date().toISOString());
    const session = readManagerSession.get(sessionId);
    if (!session) return null;
    return {
      username: session.username,
      teamId: session.team_id,
      expiresAt: session.expires_at,
    };
  }

  function removeManagerSession(sessionId) {
    deleteManagerSession.run(sessionId);
  }

  function replaceUntouchedFirstDraftPool() {
    deleteAllRacerGrowth.run();
    deleteAllTradeOffers.run();
    deleteAllTransactions.run();
    deleteAllRacers.run();
    seedOpeningDraftPool();
    ensureGrowthRows();
  }

  for (const row of readRaceSeasons.all()) {
    finalizeSeasonHistory(row.season);
  }
  const startupSeason = getActiveSeason();
  if (
    startupSeason === 1
    && countSeasonRaces.get(1).count === 0
    && !readDraftState.get()
  ) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (countStaleFirstDraftRacers.get().count > 0) {
        replaceUntouchedFirstDraftPool();
      } else {
        returnInitialRostersToFirstDraft.run();
        moveSeededFreeAgentsToFirstDraft.run();
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  if (
    startupSeason > 1
    && countSeasonRaces.get(startupSeason).count === 0
    && !readDraftState.get()
    && countSignedRacers.get().count > 0
  ) {
    database.exec("BEGIN IMMEDIATE");
    try {
      relegateFreeAgents.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    close: () => database.close(),
    beginNextSeason,
    createRace,
    getActiveSeason,
    getLeagueState,
    getDraft,
    getInitiationMartyr,
    getInMemoriam,
    getMediaEntries,
    getRookieDraft,
    getDevelopment,
    getRace,
    getRaceCenter,
    getSeasonHistory,
    getRacerDirectory,
    finishRace,
    finishActiveRaceNow,
    fastForwardToRace10,
    autoPickCurrentDraft,
    skipOpeningDraftAndMartyr,
    autoCompleteRookieReleases,
    createManagerSession,
    createMediaEntry,
    deleteMediaEntry,
    draftVoteAlertIdsForSession,
    getTransactions,
    markTradeAlertsSeen,
    markDraftVoteAlertsSeen,
    getManagerSession,
    loginManager,
    makeDraftPick,
    markMediaEntrySeen,
    maintainRookieDraft,
    makeRookieDraftPick,
    proposeTrade,
    recordRaceParticipation,
    resetActiveSeasonRaces,
    restartActiveSeason,
    registerManager,
    removeManagerSession,
    renameCar,
    releaseRacerAfterRookieDraft,
    respondToTrade,
    saveTeamPlan,
    chooseWeeklyUpgrade,
    chooseWeeklyCarUpgrade,
    signFreeAgent,
    startDraft,
    updateTeamBrand,
    updateMediaEntry,
    voteToStartRookieDraft,
    voteToStartDraft,
    voteForInitiationMartyr,
  };
}

function readAllRacerNamesSafe(database) {
  return database.prepare("SELECT name FROM racers").all().map((row) => row.name);
}
