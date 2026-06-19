import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  buildEntries, defaultCarNames, defaultLineup, teams,
} from "./league-data.mjs";
import { generateRacerNames } from "./racer-names.mjs";
import { COURSES } from "./courses.mjs";
import {
  appendStrangeEffectSummary, personalizeRaceFeedMessage,
  selectRaceCondition, simulateRace, TOTAL_LAPS,
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
const MVD_OPENER_BONUS_UNITS = 0.01 * TOTAL_LAPS;
const MVD_CLOSER_BONUS_UNITS = 0.02 * TOTAL_LAPS;
const LEAGUE_CODE = "shreveport";
const STEWARD_USERNAME = "devman";
const STEWARD_PASSWORD = "devman";
const TRACKS = COURSES.map((course) => course.name);
const PRONOUNS = ["She/Her", "He/Him", "They/Them", "It/It"];
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

function firstRaceAtForDraft(startedAt) {
  const draftStart = new Date(startedAt);
  const raceAt = new Date(draftStart);
  raceAt.setHours(20, 0, 0, 0);
  if (draftStart >= raceAt) raceAt.setDate(raceAt.getDate() + 1);
  while (raceAt.getDay() === 0 || raceAt.getDay() === 6) {
    raceAt.setDate(raceAt.getDate() + 1);
  }
  return raceAt.toISOString();
}

function scheduledRaceAtForIndex(firstRaceAt, raceIndex) {
  const raceAt = new Date(firstRaceAt);
  for (let index = 0; index < raceIndex; index += 1) {
    raceAt.setDate(raceAt.getDate() + 1);
    while (raceAt.getDay() === 0 || raceAt.getDay() === 6) {
      raceAt.setDate(raceAt.getDate() + 1);
    }
  }
  return raceAt.toISOString();
}

function nextAvailableRaceAt(firstRaceAt, raceIndex, now = new Date()) {
  const raceAt = new Date(scheduledRaceAtForIndex(firstRaceAt, raceIndex));
  while (raceAt.getTime() + (2 * 60 * 60 * 1000) < now.getTime()) {
    raceAt.setDate(raceAt.getDate() + 1);
    while (raceAt.getDay() === 0 || raceAt.getDay() === 6) {
      raceAt.setDate(raceAt.getDate() + 1);
    }
  }
  return raceAt.toISOString();
}

function nextWeekdayRaceAt(previousRaceAt) {
  const raceAt = new Date(previousRaceAt);
  raceAt.setDate(raceAt.getDate() + 1);
  while (raceAt.getDay() === 0 || raceAt.getDay() === 6) {
    raceAt.setDate(raceAt.getDate() + 1);
  }
  raceAt.setHours(20, 0, 0, 0);
  return raceAt.toISOString();
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

function qualifierLapTime(entry, driver, course) {
  const paceTerm = (0.7 * driver.pace) + (0.3 * entry.vehicle.speed);
  const segmentTime = course.segments
    .filter((segment) => segment.type === "turn" || segment.type === "chicane")
    .reduce((total, segment) => (
      total
      + segment.severity
      + 5
      - ((0.35 * driver.control) + (0.15 * entry.vehicle.handling))
    ), 0);
  return 40 + course.length - paceTerm + segmentTime;
}

function applyQualifierGrid(entries, standings, courseName) {
  const course = COURSES.find((item) => item.name === courseName) || COURSES[0];
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
    const lapTimes = drivers.map((driver) => qualifierLapTime(entry, driver, course));
    return {
      entryId: entry.id,
      carName: entry.carName,
      teamId: entry.teamId,
      qualificationOrder: qualificationIndex + 1,
      drivers: drivers.map((driver) => driver.name),
      lapTimes,
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
      status TEXT NOT NULL CHECK (status IN ('active', 'releases', 'complete')),
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
  const raceColumns = database.prepare("PRAGMA table_info(races)").all();
  if (!raceColumns.some((column) => column.name === "start_at")) {
    database.exec("ALTER TABLE races ADD COLUMN start_at TEXT");
    database.exec("UPDATE races SET start_at = created_at WHERE start_at IS NULL");
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
    SELECT season, team_id, voted_at
    FROM draft_initiation_votes
    WHERE season = ?
    ORDER BY voted_at, team_id
  `);
  const insertDraftInitiationVote = database.prepare(`
    INSERT OR IGNORE INTO draft_initiation_votes (season, team_id, voted_at)
    VALUES (?, ?, ?)
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
    ) VALUES (?, 'active', ?, ?, 1, ?, ?, NULL)
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
      week, team_id, option_index, racer_id, stat, result, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
      week, team_id, option_index, car_index, stat, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
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
  const readRace = database.prepare("SELECT * FROM races WHERE id = ?");
  const readAllRacePayloads = database.prepare(`
    SELECT id, entries_json, events_json FROM races
  `);
  const updateRacePayload = database.prepare(`
    UPDATE races SET entries_json = ?, events_json = ? WHERE id = ?
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

  function seasonWeekKey(season, week) {
    return ((season - 1) * WEEKS_PER_SEASON) + week;
  }

  function displayWeekForKey(week) {
    return ((week - 1) % WEEKS_PER_SEASON) + 1;
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

  function saveTeamPlan(teamId, input) {
    if (readRuntime.get().active_race_id !== null) {
      throw new Error("Relay plans are locked while a league race is happening.");
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
    const initiation = {
      season,
      votes: initiationVotes,
      voteCount: initiationVotes.length,
      requiredVotes: teams.length,
      ready: initiationVotes.length >= teams.length,
      allTeamsAssigned: readManagerTeams.all().length >= teams.length,
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
    const deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
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
        deadline,
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
    startRookieDraft(season, now);
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
      teamsAwaitingRelease: state.status === "releases"
        ? teams.filter((team) => !releases.some((release) => release.team_id === team.id))
          .map((team) => team.id)
        : [],
    };
  }

  function makeRookieDraftPick(racerId, season = 1, now = new Date()) {
    startRookieDraft(season, now);
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
    startRookieDraft(season, now);
    let previousPick = null;
    let current = readRookieDraftState.get(season);
    while (current?.status === "active" && current.current_pick !== previousPick) {
      previousPick = current.current_pick;
      processRookieAutopick(season, now);
      current = readRookieDraftState.get(season);
    }
    return getRookieDraft(season, now);
  }

  function startDraft({ rounds = 8, poolSize = 60, seed = Date.now() } = {}) {
    if (readDraftState.get()) throw new Error("A draft already exists.");
    if (!Number.isInteger(rounds) || rounds < 6 || rounds > 12) {
      throw new Error("Draft rounds must be between 6 and 12.");
    }
    if (!Number.isInteger(poolSize) || poolSize < rounds * teams.length) {
      throw new Error("The draft pool must contain at least one racer per pick.");
    }

    const returningRacerCount = countDraftPoolRacers.get().count;
    if (returningRacerCount > poolSize) {
      throw new Error("The returning roster is larger than the opening draft pool.");
    }
    const newRacerCount = poolSize - returningRacerCount;
    const reservedNames = readAllRacerNames.all().map((row) => row.name);
    const names = generateRacerNames(newRacerCount, Number(seed), reservedNames);
    const random = seededRandom(Number(seed));
    const notes = [
      "Keeps a spare horizon in the glovebox.",
      "Has never lost an argument with a hairpin.",
      "Claims the racing line appeared in a dream.",
      "Can identify engines by their favorite weather.",
      "Carries an emergency duplicate of the moon.",
      "Refuses to acknowledge conventional braking zones.",
    ];

    database.exec("BEGIN");
    try {
      insertDraftState.run(rounds, poolSize, Number(seed), new Date().toISOString());
      names.forEach((name, index) => {
        const rating = () => 4 + Math.floor(random() * 6);
        const racerId = `draft-${getActiveSeason()}-${Number(seed)}-${index + 1}`;
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
    teamId, leagueCode, rounds = 8, poolSize = 60, seed = Date.now(),
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
    insertDraftInitiationVote.run(season, teamId, new Date().toISOString());
    if (readDraftInitiationVotes.all(season).length >= teams.length) {
      return startDraft({ rounds, poolSize, seed });
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
        clearRosters.run();
        for (const team of teams) {
          const selected = pickedRacersForTeam.all(team.id);
          selected.forEach((row) => assignRacer.run(team.id, row.racer_id));
          clearTeamStints.run(team.id);
          selected.slice(0, 6).forEach((row, slot) => {
            insertStint.run(team.id, Math.floor(slot / 3), slot % 3, row.racer_id, 20);
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

  function getTransactions() {
    const draft = readDraftState.get();
    return {
      freeAgents: draft?.status === "active"
        ? readNonDraftFreeAgents.all()
        : readAllFreeAgents.all(),
      offers: readTradeOffers.all(),
      history: readTransactions.all(),
    };
  }

  function getRacerDirectory() {
    const careerByRacer = new Map();
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
    return {
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
    const seasonRacesRun = countSeasonRaces.get(season).count;
    const week = Math.min(WEEKS_PER_SEASON, Math.floor(seasonRacesRun / RACES_PER_WEEK) + 1);
    const racesRun = countWeekRaces.get(season, week).count;
    const activeRaceId = readRuntime.get().active_race_id;
    const completedAllRaces = readAllRacesForCareer.all()
      .filter((race) => race.id !== activeRaceId);
    const completedSeasonRaces = completedAllRaces
      .filter((race) => race.season === season);
    const seasonComplete = completedSeasonRaces.length >= SEASON_RACES;
    const nextRaceNumber = seasonComplete ? null : racesRun + 1;
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
      )
        .map((entry) => ({
          id: entry.id,
          carName: entry.carName,
          teamId: entry.teamId,
          color: entry.color,
          driver: entry.stints[0]?.driver?.name || "",
          gridPosition: entry.startingGridPosition,
          qualifierTime: entry.qualifier?.totalTime || 0,
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
      forecastCondition: nextRaceNumber
        ? selectRaceCondition(trackName, forecastSeed)
        : null,
      activeRaceId,
      raceActive: activeRaceId !== null,
      seasonComplete,
      races: readRaceSummaries.all().filter((race) => race.id !== activeRaceId),
      championship: seasonChampionships.teams,
      mvdStandings: seasonChampionships.mvds,
      teamChampionshipWins: calculateTeamChampionshipWins(completedAllRaces),
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
      returnRostersToDraft.run();
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
    const week = Math.floor(seasonRacesRun / RACES_PER_WEEK) + 1;
    const raceNumber = countWeekRaces.get(season, week).count + 1;

    const league = getLeagueState();
    const baseEntries = buildEntries(
      league.lineups,
      league.carNames,
      league.rosters,
      league.cars,
      Object.fromEntries(readBrands.all().map((brand) => [brand.team_id, brand])),
    );
    const courseName = TRACKS[week - 1];
    const forecastSeed = `season-${season}-week-${week}-race-${raceNumber}`;
    const condition = forcedCondition || selectRaceCondition(courseName, forecastSeed);
    const seed = forcedSeed || `season-${season}-week-${week}-race-${raceNumber}-${Date.now()}`;
    const entries = applyQualifierGrid(
      baseEntries,
      getRaceCenter(season).championship,
      courseName,
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

      const usedAt = createdAt;
      const developmentWeek = seasonWeekKey(season, week);
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
      setActiveRace.run(null, new Date().toISOString());
      if (countSeasonRaces.get(race.season).count >= SEASON_RACES) {
        finalizeSeasonHistory(race.season);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (countSeasonRaces.get(race.season).count === 10) {
      startRookieDraft(race.season, new Date());
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
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    if (readTeamUpgradeChoice.get(week, teamId)) {
      throw new Error("This team has already used its weekly upgrade.");
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
      if (result === "improved") {
        database.prepare(`UPDATE racers SET ${stat} = ${stat} + 1 WHERE id = ?`).run(racerId);
        reduceGrowth.run(racerId, stat);
        reducePotential.run(racerId);
      } else {
        revealCap.run(racerId, stat);
      }
      insertUpgradeChoice.run(
        week,
        teamId,
        optionIndex,
        racerId,
        stat,
        result,
        new Date().toISOString(),
      );
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
      racer: publicRacer(readRoster.all(teamId).find((item) => item.id === racerId)),
    };
  }

  function chooseWeeklyCarUpgrade(teamId, carIndex, optionIndex, week = 1) {
    if (!teams.some((team) => team.id === teamId)) throw new Error("Unknown team.");
    if (readTeamCarUpgradeChoice.get(week, teamId)) {
      throw new Error("This team has already used its weekly car upgrade.");
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
      database.prepare(`UPDATE cars SET ${stat} = ${stat} + 1
        WHERE team_id = ? AND car_index = ?`).run(teamId, carIndex);
      insertCarUpgradeChoice.run(
        week,
        teamId,
        optionIndex,
        carIndex,
        stat,
        new Date().toISOString(),
      );
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
      car: readCar.get(teamId, carIndex),
    };
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
      returnRostersToDraft.run();
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
    getTransactions,
    getManagerSession,
    loginManager,
    makeDraftPick,
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
    voteToStartDraft,
    voteForInitiationMartyr,
  };
}

function readAllRacerNamesSafe(database) {
  return database.prepare("SELECT name FROM racers").all().map((row) => row.name);
}
