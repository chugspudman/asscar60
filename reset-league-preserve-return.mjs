import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { teams, defaultCarNames } from "./league-data.mjs";
import { generateRacerNames } from "./racer-names.mjs";
import { createLeagueStore, pronounsForRacer } from "./league-store.mjs";

const dbPath = process.env.ASSCAR_DB_PATH || "/data/asscar60.sqlite";
const preservedMediaTitle = "The Return";

// Run the normal store bootstrap first so older live databases receive any
// schema migrations before the direct reset statements below run.
const store = createLeagueStore(dbPath);
store.close?.();

const database = new DatabaseSync(dbPath);

function readAllRacerNamesSafe() {
  return database.prepare("SELECT name FROM racers").all().map((row) => row.name);
}

function seedOpeningDraftPool(seed = randomBytes(4).readUInt32BE(0)) {
  const random = (() => {
    let state = seed >>> 0;
    return () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const names = generateRacerNames(60, seed, readAllRacerNamesSafe());
  const notes = [
    "Keeps a spare horizon in the glovebox.",
    "Has never lost an argument with a hairpin.",
    "Claims the racing line appeared in a dream.",
    "Can identify engines by their favorite weather.",
    "Carries an emergency duplicate of the moon.",
    "Refuses to acknowledge conventional braking zones.",
  ];
  const insertRacer = database.prepare(`
    INSERT INTO racers (
      id, name, pace, control, overtaking, stamina, technical, weird,
      speed_mark, potential, note, pronouns, robotoid, team_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, NULL, 'draft')
  `);
  names.forEach((name, index) => {
    const rating = () => 4 + Math.floor(random() * 6);
    const racerId = `opening-draft-${seed}-${index + 1}`;
    insertRacer.run(
      racerId,
      name,
      5,
      rating(),
      rating(),
      rating(),
      5,
      5,
      1 + Math.floor(random() * 5),
      notes[Math.floor(random() * notes.length)],
      pronounsForRacer(racerId),
    );
  });
  return { seed, count: names.length };
}

const preservedMediaIds = database.prepare(`
  SELECT id FROM media_entries
  WHERE lower(title) = lower(?)
`).all(preservedMediaTitle).map((row) => row.id);
const mediaKeepList = preservedMediaIds.map(() => "?").join(", ");

database.exec("BEGIN IMMEDIATE");
try {
  database.prepare("UPDATE league_runtime SET active_race_id = NULL, active_season = 1, updated_at = ? WHERE id = 1")
    .run(new Date().toISOString());

  for (const table of [
    "manager_sessions",
    "race_laps",
    "race_results",
    "races",
    "season_history",
    "season_course_schedule",
    "weekly_race_participation",
    "weekly_upgrade_choices",
    "weekly_upgrade_weeks",
    "weekly_car_upgrade_choices",
    "weekly_car_upgrade_weeks",
    "racer_growth",
    "transactions",
    "trade_alert_reads",
    "trade_offers",
    "traded_draft_pick_rights",
    "traded_training_rights",
    "traded_car_upgrade_rights",
    "draft_vote_alert_reads",
    "pit_coach_selections",
    "season_event_effects",
    "season_event_reads",
    "season_event_rolls",
    "season_events",
    "rookie_draft_releases",
    "rookie_draft_picks",
    "rookie_draft_initiation_votes",
    "rookie_draft_state",
    "dark_sacrifice_votes",
    "dark_sacrifice_state",
    "initiation_martyr_votes",
    "initiation_martyr_state",
    "draft_retention_selections",
    "draft_initiation_votes",
    "draft_picks",
    "draft_state",
    "relay_stints",
    "cars",
    "team_plans",
    "team_brands",
    "racers",
  ]) {
    database.exec(`DELETE FROM ${table}`);
  }

  if (preservedMediaIds.length) {
    database.prepare(`DELETE FROM media_entry_reads WHERE media_entry_id NOT IN (${mediaKeepList})`)
      .run(...preservedMediaIds);
    database.prepare(`DELETE FROM media_entries WHERE id NOT IN (${mediaKeepList})`)
      .run(...preservedMediaIds);
  } else {
    database.exec("DELETE FROM media_entry_reads");
    database.exec("DELETE FROM media_entries");
  }

  const now = new Date().toISOString();
  const insertBrand = database.prepare(`
    INSERT INTO team_brands (
      team_id, name, abbreviation, color, name_changed_season,
      abbreviation_changed_season, color_changed_season, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
  `);
  const insertTeamPlan = database.prepare(`
    INSERT INTO team_plans (team_id, car_one_name, car_two_name, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertCar = database.prepare(`
    INSERT INTO cars (team_id, car_index, speed, handling, durability, feedback, weird)
    VALUES (?, ?, 3, 3, 3, 3, 3)
  `);
  for (const team of teams) {
    const carNames = defaultCarNames(team);
    insertBrand.run(team.id, team.name, team.short, team.color, now);
    insertTeamPlan.run(team.id, carNames[0], carNames[1], now);
    insertCar.run(team.id, 0);
    insertCar.run(team.id, 1);
  }

  const draftPool = seedOpeningDraftPool();

  database.exec("COMMIT");

  const managers = database.prepare("SELECT COUNT(*) AS count FROM managers").get().count;
  console.log("ASSCAR60 league reset complete.");
  console.log(`Database: ${dbPath}`);
  console.log(`Manager logins preserved: ${managers}`);
  console.log(`Media entries preserved with title \"${preservedMediaTitle}\": ${preservedMediaIds.length}`);
  console.log(`New opening draft pool generated: ${draftPool.count}`);
  console.log("League state: Season 1, before the opening draft.");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}
