import {
  buildEntries, defaultCarNames, defaultLineup, teams,
} from "./league-data.mjs";
import { formatRaceTime, pronounForms, TOTAL_LAPS } from "./simulation.mjs";
import { COURSES, courseByName, courseSummary } from "./courses.mjs";

const defaultLineups = Object.fromEntries(
  teams.map((team) => [team.id, defaultLineup(team)]),
);
const defaultCarNamesByTeam = Object.fromEntries(
  teams.map((team) => [team.id, defaultCarNames(team)]),
);
const SECTION_TABS = {
  race: [
    { view: "race", label: "Current Race" },
    { view: "course", label: "Courses" },
    { view: "archive", label: "Archive" },
  ],
  garage: [
    { view: "relay", label: "Relay Plan" },
    { view: "roster", label: "Roster" },
    { view: "cars", label: "Cars" },
  ],
  office: [
    { view: "draft", label: "Draft" },
    { view: "brand", label: "Brand" },
    { view: "moves", label: "Roster Moves" },
    { view: "development", label: "Development" },
    { view: "stewards", label: "Stewards" },
  ],
  league: [
    { view: "standings", label: "Standings" },
    { view: "league", label: "Teams" },
    { view: "signed", label: "Signed Racers" },
    { view: "free-agents", label: "Free Agents" },
    { view: "memoriam", label: "In Memoriam" },
  ],
};
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

const previewRaceAt = new URLSearchParams(window.location.search).get("previewRaceAt");
const previewRaceAtMs = previewRaceAt ? new Date(previewRaceAt).getTime() : null;
const previewLoadedAtMs = Date.now();

function currentTimeMs() {
  return Number.isFinite(previewRaceAtMs)
    ? previewRaceAtMs + (Date.now() - previewLoadedAtMs)
    : Date.now();
}

function currentDate() {
  return new Date(currentTimeMs());
}

function clearPreviewClock() {
  if (!Number.isFinite(previewRaceAtMs)) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("previewRaceAt");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function raceElapsedSinceStart(startAt) {
  const startMs = new Date(startAt).getTime();
  return ((Number.isFinite(previewRaceAtMs) ? Date.now() : currentTimeMs()) - startMs) / 1000;
}

const state = {
  activeSection: "race",
  activeViewBySection: {
    race: "race",
    garage: "relay",
    office: "draft",
    league: "standings",
  },
  managerUsername: null,
  managerTeamId: null,
  selectedTeamId: teams[0].id,
  relayPlanEditing: false,
  lineups: defaultLineups,
  carNames: defaultCarNamesByTeam,
  cars: {},
  race: null,
  timer: null,
  startedAt: 0,
  elapsed: 0,
  eventIndex: 0,
  running: false,
  replay: false,
  idleFeedKey: null,
  draft: { status: "not_started", picks: [], pool: [] },
  rookieDraft: { status: "not_started", picks: [], pool: [], releases: [] },
  draftVoteAlertKeys: [],
  noticedDraftVoteAlertKeys: [],
  clearedDraftVoteAlertKeys: [],
  unreadDraftVoteAlertIds: [],
  martyr: { status: "not_started", candidates: [], votes: [], martyr: null },
  transactions: { freeAgents: [], offers: [], history: [] },
  inMemoriam: [],
  development: {
    week: 1,
    options: [],
    choices: [],
    eligibleRacerIdsByTeam: {},
    carOptions: [],
    carChoices: [],
  },
  raceCenter: {
    season: 1,
    week: 1,
    weeksPerSeason: 4,
    racesPerWeek: 5,
    seasonRaces: 20,
    seasonRacesRun: 0,
    racesRun: 0,
    nextRaceNumber: 1,
    trackName: "Race City",
    forecastCondition: "Sunny",
    raceActive: false,
    races: [],
    championship: [],
    mvdStandings: [],
    teamChampionshipWins: {},
    champions: null,
  },
  activeLeagueRace: null,
  racerDirectory: { signed: [], freeAgents: [] },
  mediaEntries: [],
  mediaAuthorProfiles: [],
  unreadMediaEntryIds: [],
  mediaMenuNoticed: false,
  expandedMediaEntryId: null,
  editingMediaEntryId: null,
  brands: {},
  brandColors: [],
};

const elements = {
  authView: document.querySelector("#auth-view"),
  appViews: document.querySelectorAll(".site-header, .subnav-shell, main, footer"),
  showLogin: document.querySelector("#show-login"),
  showRegister: document.querySelector("#show-register"),
  loginForm: document.querySelector("#login-form"),
  registerForm: document.querySelector("#register-form"),
  authMessage: document.querySelector("#auth-message"),
  loginUsername: document.querySelector("#login-username"),
  loginPassword: document.querySelector("#login-password"),
  registerUsername: document.querySelector("#register-username"),
  registerPassword: document.querySelector("#register-password"),
  leagueCode: document.querySelector("#league-code"),
  subnav: document.querySelector("#subnav"),
  raceStatusBanner: document.querySelector("#race-status-banner"),
  raceBannerTitle: document.querySelector("#race-banner-title"),
  raceBannerCondition: document.querySelector("#race-banner-condition"),
  newsTickerText: document.querySelector("#news-ticker-text"),
  seasonLabel: document.querySelector("#season-label"),
  archiveSeasonLabel: document.querySelector("#archive-season-label"),
  developmentWeek: document.querySelector("#development-week"),
  raceTitle: document.querySelector("#race-title"),
  clock: document.querySelector("#race-clock"),
  leader: document.querySelector("#race-leader"),
  lap: document.querySelector("#lap-indicator"),
  standings: document.querySelector("#standings"),
  raceProgressTrack: document.querySelector("#race-progress-track"),
  raceProgressLabel: document.querySelector("#race-progress-label"),
  feed: document.querySelector("#race-feed"),
  raceButton: document.querySelector("#race-button"),
  racePodium: document.querySelector("#race-podium"),
  speed: document.querySelector("#speed-control"),
  teamProfile: document.querySelector("#team-profile"),
  lineupEditor: document.querySelector("#lineup-editor"),
  teamGrid: document.querySelector("#team-grid"),
  saveLineup: document.querySelector("#save-lineup"),
  saveMessage: document.querySelector("#save-message"),
  draftEmpty: document.querySelector("#draft-empty"),
  draftRoom: document.querySelector("#draft-room"),
  draftStatus: document.querySelector("#draft-status"),
  draftLayout: document.querySelector("#draft-layout"),
  draftPoolPanel: document.querySelector("#draft-pool-panel"),
  draftHistoryTitle: document.querySelector("#draft-history-title"),
  startDraft: document.querySelector("#start-draft"),
  draftRetentionFields: document.querySelector("#draft-retention-fields"),
  draftRetainVeteran: document.querySelector("#draft-retain-veteran"),
  draftRetainRookie: document.querySelector("#draft-retain-rookie"),
  draftInitiationCode: document.querySelector("#draft-initiation-code"),
  draftInitiationProgress: document.querySelector("#draft-initiation-progress"),
  draftTeam: document.querySelector("#draft-team"),
  draftPick: document.querySelector("#draft-pick"),
  draftAvailable: document.querySelector("#draft-available"),
  draftMessage: document.querySelector("#draft-message"),
  draftPool: document.querySelector("#draft-pool"),
  draftHistory: document.querySelector("#draft-history"),
  draftSort: document.querySelector("#draft-sort"),
  rookieDraftRoom: document.querySelector("#rookie-draft-room"),
  rookieDraftHeading: document.querySelector("#rookie-draft-heading"),
  rookieDraftStatus: document.querySelector("#rookie-draft-status"),
  rookieDraftLayout: document.querySelector("#rookie-draft-layout"),
  rookieDraftPoolPanel: document.querySelector("#rookie-draft-pool-panel"),
  rookieDraftInitiation: document.querySelector("#rookie-draft-initiation"),
  rookieDraftInitiationCode: document.querySelector("#rookie-draft-initiation-code"),
  rookieDraftInitiationProgress: document.querySelector("#rookie-draft-initiation-progress"),
  startRookieDraft: document.querySelector("#start-rookie-draft"),
  rookieDraftHistoryTitle: document.querySelector("#rookie-draft-history-title"),
  rookieDraftClock: document.querySelector("#rookie-draft-clock"),
  rookieDraftTeam: document.querySelector("#rookie-draft-team"),
  rookieDraftPick: document.querySelector("#rookie-draft-pick"),
  rookieDraftAvailable: document.querySelector("#rookie-draft-available"),
  rookieDraftMessage: document.querySelector("#rookie-draft-message"),
  rookieDraftSort: document.querySelector("#rookie-draft-sort"),
  rookieDraftPool: document.querySelector("#rookie-draft-pool"),
  rookieDraftHistory: document.querySelector("#rookie-draft-history"),
  rookieReleasePanel: document.querySelector("#rookie-release-panel"),
  rookieReleaseTeam: document.querySelector("#rookie-release-team"),
  rookieReleaseRacer: document.querySelector("#rookie-release-racer"),
  submitRookieRelease: document.querySelector("#submit-rookie-release"),
  movesTeam: document.querySelector("#moves-team"),
  movesMessage: document.querySelector("#moves-message"),
  tradeAlertMessage: document.querySelector("#trade-alert-message"),
  tradeOffered: document.querySelector("#trade-offered"),
  tradeTeam: document.querySelector("#trade-team"),
  tradeRequested: document.querySelector("#trade-requested"),
  proposeTrade: document.querySelector("#propose-trade"),
  freeAgent: document.querySelector("#free-agent"),
  releaseRacer: document.querySelector("#release-racer"),
  signFreeAgent: document.querySelector("#sign-free-agent"),
  tradeOffers: document.querySelector("#trade-offers"),
  transactionHistory: document.querySelector("#transaction-history"),
  developmentTeam: document.querySelector("#development-team"),
  developmentMessage: document.querySelector("#development-message"),
  upgradeOptions: document.querySelector("#upgrade-options"),
  carUpgradeOptions: document.querySelector("#car-upgrade-options"),
  developmentHistory: document.querySelector("#development-history"),
  stewardsPanel: document.querySelector("#stewards-view"),
  stewardsMessage: document.querySelector("#stewards-message"),
  stewardsResetDialog: document.querySelector("#stewards-reset-dialog"),
  cancelStewardsReset: document.querySelector("#cancel-stewards-reset"),
  confirmStewardsReset: document.querySelector("#confirm-stewards-reset"),
  raceHistory: document.querySelector("#race-history"),
  raceReviewPanel: document.querySelector("#race-review-panel"),
  raceReviewTitle: document.querySelector("#race-review-title"),
  raceReviewRecap: document.querySelector("#race-review-recap"),
  raceReviewStandings: document.querySelector("#race-review-standings"),
  raceReviewRelay: document.querySelector("#race-review-relay"),
  raceReviewFeed: document.querySelector("#race-review-feed"),
  courseList: document.querySelector("#course-list"),
  championship: document.querySelector("#championship-standings"),
  mvdStandings: document.querySelector("#mvd-standings"),
  standingsSeasonLabel: document.querySelector("#standings-season-label"),
  seasonChampions: document.querySelector("#season-champions"),
  garageCars: document.querySelector("#garage-cars"),
  signedRacers: document.querySelector("#signed-racers"),
  freeAgentRacers: document.querySelector("#free-agent-racers"),
  memoriamList: document.querySelector("#memoriam-list"),
  signedRacerSort: document.querySelector("#signed-racer-sort"),
  freeAgentRacerSort: document.querySelector("#free-agent-racer-sort"),
  brandTeam: document.querySelector("#brand-team"),
  brandEditor: document.querySelector("#brand-editor"),
  brandMessage: document.querySelector("#brand-message"),
  brandConfirmDialog: document.querySelector("#brand-confirm-dialog"),
  brandConfirmMessage: document.querySelector("#brand-confirm-message"),
  confirmBrandChange: document.querySelector("#confirm-brand-change"),
  cancelBrandChange: document.querySelector("#cancel-brand-change"),
  martyrVoteDialog: document.querySelector("#martyr-vote-dialog"),
  martyrTeam: document.querySelector("#martyr-team"),
  martyrCandidate: document.querySelector("#martyr-candidate"),
  martyrVoteProgress: document.querySelector("#martyr-vote-progress"),
  martyrVoteMessage: document.querySelector("#martyr-vote-message"),
  submitMartyrVote: document.querySelector("#submit-martyr-vote"),
  martyrResultDialog: document.querySelector("#martyr-result-dialog"),
  martyrResultMessage: document.querySelector("#martyr-result-message"),
  closeMartyrResult: document.querySelector("#close-martyr-result"),
  seasonCeremonyDialog: document.querySelector("#season-ceremony-dialog"),
  seasonCeremonySeason: document.querySelector("#season-ceremony-season"),
  seasonCeremonyHonors: document.querySelector("#season-ceremony-honors"),
  closeSeasonCeremony: document.querySelector("#close-season-ceremony"),
  nextSeasonDialog: document.querySelector("#next-season-dialog"),
  cancelNextSeason: document.querySelector("#cancel-next-season"),
  confirmNextSeason: document.querySelector("#confirm-next-season"),
  appMenuButton: document.querySelector("#app-menu-button"),
  appMenu: document.querySelector("#app-menu"),
  openRules: document.querySelector("#open-rules"),
  openMedia: document.querySelector("#open-media"),
  openWiki: document.querySelector("#open-wiki"),
  menuLogout: document.querySelector("#menu-logout"),
  rulesPage: document.querySelector("#rules-view"),
  closeRules: document.querySelector("#close-rules"),
  mediaPage: document.querySelector("#media-view"),
  mediaList: document.querySelector("#media-list"),
  addMediaEntry: document.querySelector("#add-media-entry"),
  mediaDialog: document.querySelector("#media-dialog"),
  mediaForm: document.querySelector("#media-form"),
  mediaDialogTitle: document.querySelector("#media-dialog-title"),
  mediaTitle: document.querySelector("#media-title"),
  mediaAuthorField: document.querySelector("#media-author-field"),
  mediaAuthor: document.querySelector("#media-author"),
  mediaBody: document.querySelector("#media-body"),
  mediaMessage: document.querySelector("#media-message"),
  cancelMediaEntry: document.querySelector("#cancel-media-entry"),
  saveMediaEntry: document.querySelector("#save-media-entry"),
  logoutDialog: document.querySelector("#logout-dialog"),
  cancelLogout: document.querySelector("#cancel-logout"),
  confirmLogout: document.querySelector("#confirm-logout"),
};
let pendingBrandChange = null;
let appStarted = false;
let raceCenterInterval = null;
let draftInterval = null;
let rookieDraftInterval = null;
let martyrInterval = null;
let transactionsInterval = null;
let mediaInterval = null;
let tickerResizeFrame = null;
const managerStorageKey = "asscar60.managerUsername";
const managerTeamStorageKey = "asscar60.managerTeamId";
const navigationStorageKey = "asscar60.navigation";
const PRE_RACE_CARD_SECONDS = 10 * 60;

function setAuthMode(mode) {
  const registering = mode === "register";
  elements.loginForm.hidden = registering;
  elements.registerForm.hidden = !registering;
  elements.showLogin.classList.toggle("active", !registering);
  elements.showRegister.classList.toggle("active", registering);
  elements.showLogin.setAttribute("aria-selected", String(!registering));
  elements.showRegister.setAttribute("aria-selected", String(registering));
  elements.authMessage.textContent = "";
  elements.authMessage.classList.remove("success");
}

function showGameShell() {
  elements.authView.hidden = true;
  elements.appViews.forEach((element) => { element.hidden = false; });
}

function showAuthError(message) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.remove("success");
}

function showAuthSuccess(message) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.add("success");
}

function managerTeamAbbreviation() {
  const teamId = state.managerTeamId || state.selectedTeamId;
  const team = teams.find((item) => item.id === teamId);
  return state.brands[teamId]?.abbreviation || team?.short || "";
}

function managedTeamId() {
  return state.managerTeamId || state.selectedTeamId || teams[0].id;
}

function managedTeam() {
  return teams.find((team) => team.id === managedTeamId()) || teams[0];
}

function isStewardManager() {
  return state.managerUsername === "devman";
}

function tabsForSection(sectionName) {
  const tabs = SECTION_TABS[sectionName] || [];
  if (sectionName !== "office" || isStewardManager()) return tabs;
  return tabs.filter((tab) => tab.view !== "stewards");
}

function readNavigationState() {
  try {
    return JSON.parse(window.localStorage.getItem(navigationStorageKey) || "{}");
  } catch {
    return {};
  }
}

function writeNavigationState(mode = "section") {
  window.localStorage.setItem(navigationStorageKey, JSON.stringify({
    mode,
    activeSection: state.activeSection,
    activeViewBySection: state.activeViewBySection,
  }));
}

function restoreNavigationState() {
  const saved = readNavigationState();
  const savedViews = saved.activeViewBySection || {};
  const section = SECTION_TABS[saved.activeSection] ? saved.activeSection : state.activeSection;
  state.activeSection = section;
  state.activeViewBySection = {
    ...state.activeViewBySection,
    ...Object.fromEntries(Object.entries(savedViews).filter(([key, view]) => (
      tabsForSection(key).some((tab) => tab.view === view)
    ))),
  };
  return ["rules", "media"].includes(saved.mode) ? saved.mode : "section";
}

function managedTeamLabel() {
  const team = managedTeam();
  return `${team.short} / ${team.name}`;
}

async function submitManagerAuth(path, form) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not authenticate manager.");
  state.managerUsername = result.username;
  window.localStorage.setItem(managerStorageKey, result.username);
  if (result.teamId) {
    window.localStorage.setItem(managerTeamStorageKey, result.teamId);
    state.managerTeamId = result.teamId;
    state.selectedTeamId = result.teamId;
  } else {
    window.localStorage.removeItem(managerTeamStorageKey);
    state.managerTeamId = null;
  }
  const assignedTeam = teams.find((team) => team.id === result.teamId);
  showAuthSuccess(`Signed in as ${result.username}${assignedTeam ? ` (${assignedTeam.name})` : ""}.`);
  await startApp();
}

async function restoreManagerSession() {
  const response = await fetch("/api/managers/session");
  if (!response.ok) throw new Error("No active manager session.");
  const result = await response.json();
  state.managerUsername = result.username;
  window.localStorage.setItem(managerStorageKey, result.username);
  if (result.teamId) {
    window.localStorage.setItem(managerTeamStorageKey, result.teamId);
    state.managerTeamId = result.teamId;
    state.selectedTeamId = result.teamId;
  } else {
    window.localStorage.removeItem(managerTeamStorageKey);
    state.managerTeamId = null;
  }
  await startApp();
}

function currentEntries() {
  return buildEntries(state.lineups, state.carNames, {}, state.cars);
}

function entryById(id) {
  const entries = state.race?.entries || currentEntries();
  return entries.find((entry) => entry.id === id);
}

function abbreviatedRacerName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || "";
  return `${parts[0].charAt(0)}. ${parts.slice(1).join(" ")}`;
}

function raceHeaderTitle(race = null) {
  const courseName = race?.courseName || state.raceCenter.trackName || "TBD";
  const week = race?.week || state.raceCenter.week || 1;
  const seasonRaceNumber = race
    ? ((week - 1) * state.raceCenter.racesPerWeek) + race.raceNumber
    : state.raceCenter.seasonRacesRun + 1;
  return `${courseName}, Week ${week}, Race ${seasonRaceNumber} of ${state.raceCenter.seasonRaces}`;
}

function renderRaceTitle(race = null) {
  if (!elements.raceTitle) return;
  const [courseName, raceContext] = raceHeaderTitle(race).split(", Week ");
  elements.raceTitle.innerHTML = raceContext
    ? `${escapeHtml(courseName)}<span>Week ${escapeHtml(raceContext)}</span>`
    : escapeHtml(courseName);
}

function secondsUntilNextRace() {
  if (!state.raceCenter.nextRaceAt) return null;
  return (new Date(state.raceCenter.nextRaceAt).getTime() - currentTimeMs()) / 1000;
}

function isPreRaceCardWindow() {
  const remaining = secondsUntilNextRace();
  return remaining !== null && remaining <= PRE_RACE_CARD_SECONDS;
}

function relayPlanRaceLockReason() {
  if (state.raceCenter.raceActive) {
    return "You will be able to edit your relay plan after today's race.";
  }
  const remaining = secondsUntilNextRace();
  if (remaining !== null && remaining <= PRE_RACE_CARD_SECONDS) {
    return "You will be able to edit your relay plan after today's race.";
  }
  return "";
}

function renderPreRaceCard() {
  renderRaceTitle();
  const remaining = Math.max(0, Math.ceil(secondsUntilNextRace() || 0));
  elements.clock.textContent = `- ${formatRaceTime(remaining)}`;
  elements.raceButton.disabled = true;
  elements.raceButton.textContent = "Race to begin shortly";
  renderRacePodium([]);
  if (state.raceCenter.qualifierGrid?.length) {
    elements.standings.innerHTML = qualifierGridMarkup(state.raceCenter.qualifierGrid);
    renderRaceProgress(qualifierProgressStandings(state.raceCenter.qualifierGrid), "Starting grid");
    elements.lap.textContent = "Starting grid";
  }
}

function renderHeldRaceCard() {
  if (!state.race?.finalStandings || state.race.season !== state.raceCenter.season) return false;
  renderRaceTitle(state.race);
  elements.clock.textContent = formatRaceTime(state.race.duration);
  elements.raceButton.disabled = true;
  elements.raceButton.textContent = "This race is over";
  renderRacePodium(state.race.finalStandings);
  renderRaceProgress([], "Awaiting next grid");
  return true;
}

function clearUpcomingRaceCard() {
  if (elements.raceTitle) elements.raceTitle.textContent = "";
  elements.clock.textContent = "--:--";
  renderRacePodium([]);
  renderRaceProgress([], "Awaiting grid");
}

function renderRacePodium(standings = []) {
  if (!elements.racePodium) return;
  const places = [
    ["1st", "gold"],
    ["2nd", "silver"],
    ["3rd", "bronze"],
  ];
  const finishers = [...standings]
    .filter((standing) => standing.status === "finished")
    .sort((a, b) => a.position - b.position)
    .slice(0, 3);
  elements.racePodium.innerHTML = places.map(([place, medal], index) => {
    const standing = finishers[index];
    const entry = standing ? entryById(standing.id) : null;
    const podiumTime = standing ? standing.finishTime ?? standing.elapsed : null;
    return `
      <div class="podium-slot ${standing ? "filled" : ""}">
        <span class="podium-place">${place}<i class="medal ${medal}" aria-hidden="true"></i></span>
        <span class="podium-entry">
          <strong class="podium-car">${standing ? escapeHtml(entry?.carName || standing.id) : "Unfilled"}</strong>
          <span class="podium-driver">${standing ? escapeHtml(abbreviatedRacerName(standing.driver)) : "--"}</span>
        </span>
        <span class="podium-time">${standing ? formatRaceTime(podiumTime) : "--"}</span>
      </div>`;
  }).join("");
}

function renderRaceProgress(standings = [], label = "") {
  if (!elements.raceProgressTrack) return;
  const rows = standings.length ? standings : [];
  elements.raceProgressLabel.textContent = label || (rows.length ? "Live lap" : "Awaiting grid");
  const trackEdgePercent = 1.25;
  const trackPercent = (value) => Math.min(100 - trackEdgePercent, Math.max(trackEdgePercent, clampPercent(value)));
  const course = raceProgressCourse();
  const segmentCount = course.segments.length || 1;
  const featureMarkers = course.segments.map((segment, index) => {
    const markerLeft = ((index + 0.5) / segmentCount) * 100;
    const code = segment.type === "straight" ? "S" : segment.type === "turn" ? "T" : "C";
    return `
      <span class="race-progress-feature ${segment.type}"
        style="--feature-left:${markerLeft}%"
        aria-label="${escapeAttribute(featureLabel(segment))}">
        <span>${code}</span>
      </span>`;
  }).join("");
  const leader = rows.find((standing) => standing.position === 1) || rows[0];
  const leaderEntry = leader ? entryById(leader.id) : null;
  const leaderProgress = leader ? lapProgressForStanding(leader) : 0;
  const leaderPercent = leader
    ? leader.status === "finished"
      ? 100 - trackEdgePercent
      : trackPercent(leaderProgress * 100)
    : null;
  const leaderMarker = leader ? `
      <span class="race-progress-leader"
        style="--leader-left:${leaderPercent}%; --leader-color:${leaderEntry?.color || "var(--acid)"}"
        aria-label="Current leader ${escapeAttribute(leaderEntry?.carName || leader.id)}">P1</span>`
    : "";
  const progressDots = rows.map((standing) => {
    const entry = entryById(standing.id);
    const progress = lapProgressForStanding(standing);
    const percent = standing.status === "finished"
      ? 100 - trackEdgePercent
      : standing.status === "dnf"
        ? trackPercent(progress * 100)
        : trackPercent(progress * 100);
    const labelText = `${entry?.carName || standing.id} / ${standing.driver || "Driver pending"} / ${standing.status === "dnf" ? "DNF" : `Lap ${Math.min(TOTAL_LAPS, standing.completedLaps + 1)}`}`;
    return `
      <span class="race-progress-dot ${standing.status || "running"}"
        style="--dot-left:${percent}%; --dot-color:${entry?.color || "var(--acid)"}"
        aria-label="${escapeAttribute(labelText)}"></span>`;
  }).join("");
  elements.raceProgressTrack.innerHTML = `${featureMarkers}${leaderMarker}${progressDots}`;
}

function lapProgressForStanding(standing) {
  if (Number.isFinite(standing?.raceProgress)) {
    return standing.raceProgress >= TOTAL_LAPS
      ? 1
      : clamp(standing.raceProgress - Math.floor(standing.raceProgress), 0, 0.999999);
  }
  return Number.isFinite(standing?.progress)
    ? clamp(standing.progress, 0, 0.999999)
    : 0;
}

function raceProgressCourse() {
  if (state.running && state.race?.courseName) return courseByName(state.race.courseName);
  return courseByName(
    state.activeLeagueRace?.courseName
      || state.raceCenter.trackName
      || COURSES[0].name,
  );
}

function featureLabel(segment) {
  if (segment.type === "straight") return "Straight";
  const label = segment.type === "turn" ? "Turn" : "Chicane";
  return `${label}${segment.severity ? ` severity ${segment.severity}` : ""}`;
}

const RACE_STATE_EVENT_TYPES = new Set([
  "qualifier",
  "martyr-ceremony",
  "race-start",
  "grid-chaos",
  "standings",
  "winner",
  "finish",
  "podium",
]);

function shouldRenderRaceState(event) {
  return RACE_STATE_EVENT_TYPES.has(event.type);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function formatLapTime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

function formatPerformanceTime(value) {
  return value === null || value === undefined ? "--" : formatLapTime(Number(value));
}

function formatPerformanceDelta(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  const number = Number(value);
  if (Math.abs(number) < 0.0005) return "0.000s";
  return `${number > 0 ? "+" : ""}${number.toFixed(3)}s`;
}

function racerPerformance(racerId) {
  return [...state.racerDirectory.signed, ...state.racerDirectory.freeAgents]
    .find((racer) => racer.id === racerId)?.performance || null;
}

function standingsMarkup(standings) {
  return standings.map((standing) => {
    const entry = entryById(standing.id);
    return `
      <div class="standing-row" data-entry="${standing.id}">
        <span class="position">${String(standing.position).padStart(2, "0")}</span>
        <span class="entry-name"><i class="team-stripe" style="background:${entry.color}"></i>${entry.carName}</span>
        <span class="driver-name">${abbreviatedRacerName(standing.driver)}</span>
        <span class="lap">${standing.status === "dnf" ? "DNF" : `${standing.completedLaps}/${TOTAL_LAPS}`}</span>
        <span class="last-lap-time">${standing.status === "dnf" ? "--" : formatLapTime(standing.lastLapTime)}</span>
      </div>`;
  }).join("");
}

function qualifierGridMarkup(grid) {
  return grid.map((entry) => `
    <div class="standing-row" data-entry="${entry.id}">
      <span class="position">${String(entry.gridPosition).padStart(2, "0")}</span>
      <span class="entry-name"><i class="team-stripe" style="background:${entry.color}"></i>${escapeHtml(entry.carName)}</span>
      <span class="driver-name">${escapeHtml(abbreviatedRacerName(entry.driver))}${qualifierIncidentMarkup(entry)}</span>
      <span class="lap">GRID</span>
      <span class="last-lap-time">${formatLapTime(entry.qualifierTime)}</span>
    </div>`).join("");
}

function qualifierProgressStandings(grid = []) {
  return grid.map((entry) => ({
    id: entry.id,
    position: entry.gridPosition,
    completedLaps: 0,
    progress: 0,
    raceProgress: 0,
    driver: abbreviatedRacerName(entry.driver),
    status: "running",
  })).sort((a, b) => a.position - b.position);
}

function initialRaceProgressStandings(entries = []) {
  return [...entries]
    .sort((a, b) => (
      (a.startingGridPosition ?? Number.MAX_SAFE_INTEGER)
      - (b.startingGridPosition ?? Number.MAX_SAFE_INTEGER)
    ))
    .map((entry, index) => ({
      id: entry.id,
      position: entry.startingGridPosition || index + 1,
      completedLaps: 0,
      progress: 0,
      raceProgress: 0,
      driver: entry.stints?.[0]?.driver?.name || "Awaiting draft",
      status: "running",
    }));
}

function interpolatedRaceProgressStandings(race, elapsed) {
  if (!race?.events?.length || elapsed < 0) return initialRaceProgressStandings(race?.entries || []);
  const timeline = race.events
    .filter((event) => event.standings?.length && event.time >= 0 && event.time <= race.duration)
    .sort((a, b) => a.time - b.time);
  if (!timeline.length) return initialRaceProgressStandings(race.entries || []);
  const clampedElapsed = Math.min(Math.max(0, elapsed), race.duration);
  let prior = timeline[0];
  let next = null;
  for (const event of timeline) {
    if (event.time <= clampedElapsed) {
      prior = event;
      continue;
    }
    next = event;
    break;
  }
  const nextById = new Map((next?.standings || []).map((standing) => [standing.id, standing]));
  const span = next ? Math.max(0.0001, next.time - prior.time) : 1;
  const share = next ? clamp((clampedElapsed - prior.time) / span, 0, 1) : 0;
  return prior.standings.map((standing) => {
    const following = nextById.get(standing.id);
    const currentProgress = Number.isFinite(standing.raceProgress)
      ? standing.raceProgress
      : Number.isFinite(standing.progress)
        ? standing.completedLaps + standing.progress
        : standing.completedLaps || 0;
    const nextProgress = following
      ? Number.isFinite(following.raceProgress)
        ? following.raceProgress
        : Number.isFinite(following.progress)
          ? following.completedLaps + following.progress
          : currentProgress
      : currentProgress;
    const raceProgress = standing.status === "running"
      ? currentProgress + ((nextProgress - currentProgress) * share)
      : currentProgress;
    return {
      ...standing,
      raceProgress,
      progress: raceProgress >= TOTAL_LAPS ? 1 : raceProgress - Math.floor(raceProgress),
      completedLaps: Math.min(TOTAL_LAPS, Math.floor(raceProgress)),
    };
  }).sort((a, b) => (
    (a.status === "finished") !== (b.status === "finished")
      ? a.status === "finished" ? -1 : 1
      : b.raceProgress - a.raceProgress
  )).map((standing, index) => ({
    ...standing,
    position: index + 1,
  }));
}

function qualifierIncidentMarkup(entry) {
  const parts = [];
  if (entry.qualifierMishaps) parts.push(`${entry.qualifierMishaps} mishap${entry.qualifierMishaps === 1 ? "" : "s"}`);
  if (entry.qualifierSpins) parts.push(`${entry.qualifierSpins} spin${entry.qualifierSpins === 1 ? "" : "s"}`);
  return parts.length
    ? ` <small class="qualifier-incident-note">(${escapeHtml(parts.join(", "))})</small>`
    : "";
}

function renderInitialStandings(entries = currentEntries()) {
  elements.standings.innerHTML = entries.map((entry, index) => `
    <div class="standing-row">
      <span class="position">${String(index + 1).padStart(2, "0")}</span>
      <span class="entry-name"><i class="team-stripe" style="background:${entry.color}"></i>${escapeHtml(entry.carName)}</span>
      <span class="driver-name">${escapeHtml(abbreviatedRacerName(entry.stints?.[0]?.driver?.name || "Awaiting draft"))}</span>
      <span class="lap">0/${TOTAL_LAPS}</span>
      <span class="last-lap-time">--</span>
    </div>`).join("");
  renderRacePodium([]);
}

function addFeedItem(event) {
  if (!event.message) return;
  const article = document.createElement("article");
  article.className = [
    "feed-item",
    ["winner", "podium", "martyr-ceremony"].includes(event.type) ? "feature" : "",
    event.type === "incident" ? "incident" : "",
    event.type === "strange" ? `strange ${event.tone || ""}` : "",
  ].filter(Boolean).join(" ");
  const eventTime = event.time < 0 ? `PRE ${formatRaceTime(Math.abs(event.time))}` : formatRaceTime(event.time);
  article.innerHTML = `<time>${eventTime}</time><p>${event.message}</p>`;
  elements.feed.prepend(article);
}

function raceFeedItemMarkup(event) {
  if (!event.message) return "";
  const classes = [
    "feed-item",
    ["winner", "podium", "martyr-ceremony"].includes(event.type) ? "feature" : "",
    event.type === "incident" ? "incident" : "",
    event.type === "strange" ? `strange ${event.tone || ""}` : "",
  ].filter(Boolean).join(" ");
  const eventTime = event.time < 0 ? `PRE ${formatRaceTime(Math.abs(event.time))}` : formatRaceTime(event.time);
  return `<article class="${classes}"><time>${eventTime}</time><p>${escapeHtml(event.message)}</p></article>`;
}

function resetRaceReviewButtons() {
  elements.raceHistory.querySelectorAll("[data-review-race]").forEach((button) => {
    button.classList.remove("review-open");
    button.textContent = "Review";
    delete button.dataset.reviewOpen;
  });
}

function closeRaceReview() {
  resetRaceReviewButtons();
  elements.raceReviewPanel.hidden = true;
}

function raceReviewRelayMarkup(entries = []) {
  if (!entries.length) {
    return `<p class="muted">No relay plan was recorded for this race.</p>`;
  }
  const grouped = new Map();
  entries.forEach((entry) => {
    if (!grouped.has(entry.teamId)) {
      grouped.set(entry.teamId, {
        teamName: entry.teamName || entry.teamId,
        teamShort: entry.teamShort || entry.teamId,
        color: entry.color || "var(--acid)",
        cars: [],
      });
    }
    grouped.get(entry.teamId).cars.push(entry);
  });
  return [...grouped.values()].map((team) => `
    <article class="race-review-relay-team" style="--team-color:${escapeAttribute(team.color)}; --team-text:${contrastColor(team.color)}">
      <h4><span>${escapeHtml(team.teamShort)}</span>${escapeHtml(team.teamName)}</h4>
      <div class="race-review-relay-cars">
        ${team.cars.map((car) => `
          <div class="race-review-relay-car">
            <strong>${escapeHtml(car.carName || car.id)}</strong>
            <ol>
              ${(car.stints || []).map((stint, index) => {
                const role = ["Opener", "Bridge", "Closer"][index] || `Stint ${index + 1}`;
                const laps = Number(stint.end) >= Number(stint.start)
                  ? Number(stint.end) - Number(stint.start) + 1
                  : Number(stint.laps || 0);
                return `
                  <li>
                    <span>${role}</span>
                    <b>${escapeHtml(stint.driver?.name || "Unknown driver")}</b>
                    <em>${laps} lap${laps === 1 ? "" : "s"}</em>
                  </li>`;
              }).join("")}
            </ol>
          </div>`).join("")}
      </div>
    </article>`).join("");
}

function renderRaceReview(race, button = null) {
  resetRaceReviewButtons();
  if (button) {
    button.classList.add("review-open");
    button.textContent = "Close review";
    button.dataset.reviewOpen = "true";
    button.closest(".race-record")?.insertAdjacentElement("afterend", elements.raceReviewPanel);
  }
  elements.raceReviewPanel.hidden = false;
  elements.raceReviewTitle.textContent = `${race.courseName}, Week ${race.week}, Race ${race.raceNumber}`;
  elements.raceReviewRecap.innerHTML = (race.recapText || "The Stewards have not yet filed a recap for this race.")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  elements.raceReviewStandings.innerHTML = standingsMarkup(race.finalStandings);
  if (elements.raceReviewRelay) {
    elements.raceReviewRelay.innerHTML = raceReviewRelayMarkup(race.entries);
  }
  elements.raceReviewFeed.innerHTML = race.events
    .filter((event) => event.message)
    .map(raceFeedItemMarkup)
    .join("");
  elements.raceReviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function conditionName(condition) {
  return condition || "Sunny";
}

function openingRaceSchedule() {
  if (
    state.raceCenter.seasonRacesRun !== 0
    || !state.raceCenter.nextRaceAt
  ) return null;
  const raceAt = new Date(state.raceCenter.nextRaceAt);
  return {
    raceAt,
    ceremonyAt: new Date(raceAt.getTime() - 60_000),
  };
}

function openingRaceDateLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(date);
}

async function renderIdleRaceFeed() {
  if (state.raceCenter.raceActive) return;
  const latest = state.raceCenter.races[0];
  const latestDate = latest ? new Date(latest.created_at) : null;
  const now = currentDate();
  const isToday = latestDate
    && latestDate.getFullYear() === now.getFullYear()
    && latestDate.getMonth() === now.getMonth()
    && latestDate.getDate() === now.getDate();

  const openingSchedule = openingRaceSchedule();
  const ceremonyActive = openingSchedule
    && now >= openingSchedule.ceremonyAt
    && state.martyr.status === "resolved"
    && state.martyr.martyr;
  if (!ceremonyActive && isPreRaceCardWindow() && state.raceCenter.qualifierGrid?.length) {
    const pole = state.raceCenter.qualifierGrid[0];
    const key = `qualifier:${state.raceCenter.season}:${state.raceCenter.seasonRacesRun}:${state.raceCenter.nextRaceAt || ""}:${pole.id}`;
    if (state.idleFeedKey === key) return;
    state.idleFeedKey = key;
    elements.feed.innerHTML = "";
    const article = document.createElement("article");
    article.className = "feed-item feature";
    article.innerHTML = `
      <time>PRE 10:00</time>
      <p>Qualifier relays have been run by each team's cars, and ${escapeHtml(pole.carName)} will be in pole position.</p>`;
    elements.feed.append(article);
    elements.standings.innerHTML = qualifierGridMarkup(state.raceCenter.qualifierGrid);
    renderRaceProgress(qualifierProgressStandings(state.raceCenter.qualifierGrid), "Starting grid");
    elements.lap.textContent = "Starting grid";
    return;
  }

  if (openingSchedule) {
    const key = ceremonyActive
      ? `opening-ceremony:${state.raceCenter.season}:${state.martyr.martyr.id}`
      : `opening-schedule:${state.raceCenter.season}:${openingSchedule.ceremonyAt.toISOString()}`;
    if (state.idleFeedKey === key) return;
    state.idleFeedKey = key;
    elements.feed.innerHTML = "";
    const article = document.createElement("article");
    article.className = "feed-item feature";
    if (
      ceremonyActive
    ) {
      const martyrName = escapeHtml(state.martyr.martyr.name);
      article.innerHTML = `
        <time>PRE 01:00</time>
        <p>Four figures in black robes and driving helmets lead ${martyrName} onto the black top. The aspirant driver kneels before them, hands together in prayer and trembling. The four figures draw pistols and say with voices that boom through the stands, "Speed godspeed." They then fire all at once, making mince meat out of ${martyrName}'s head. The corpse crumples to the ground, and the crowd goes wild!</p>`;
    } else {
      article.innerHTML = `
        <time>PRE</time>
        <p>The Initiation Martyring for Season ${state.raceCenter.season} will begin on ${openingRaceDateLabel(openingSchedule.ceremonyAt)} at 7:59 PM EST, to be followed by the first race of the season at 8:00 PM.</p>`;
    }
    elements.feed.append(article);
    return;
  }

  if (isToday && !isPreRaceCardWindow()) {
    const key = `archive:${latest.id}`;
    if (state.idleFeedKey === key) return;
    state.idleFeedKey = key;
    elements.feed.innerHTML = "";
    const response = await fetch(`/api/races/${latest.id}`);
    const race = await response.json();
    if (response.ok) {
      state.race = race;
      race.events.filter((event) => event.message).forEach(addFeedItem);
      elements.standings.innerHTML = standingsMarkup(race.finalStandings);
      elements.clock.textContent = formatRaceTime(race.duration);
      elements.leader.textContent = entryById(race.finalStandings[0].id).carName;
      elements.lap.textContent = "Official result";
      elements.raceButton.disabled = true;
      elements.raceButton.textContent = "This race is over";
      renderRaceTitle(race);
      renderRacePodium(race.finalStandings);
      renderRaceProgress([], "Awaiting next grid");
      return;
    }
  }

  const key = `schedule:${state.raceCenter.season}:${state.raceCenter.seasonRacesRun}:${state.raceCenter.nextRaceAt || ""}:${state.raceCenter.forecastCondition || ""}`;
  if (state.idleFeedKey === key) return;
  state.idleFeedKey = key;
  elements.feed.innerHTML = "";
  const article = document.createElement("article");
  article.className = "feed-item feature";
  const nextRaceDate = state.raceCenter.nextRaceAt
    ? openingRaceDateLabel(new Date(state.raceCenter.nextRaceAt))
    : "the scheduled date";
  article.innerHTML = `
    <time>PRE</time>
    <p>Race ${state.raceCenter.nextRaceNumber} of Week ${state.raceCenter.week} will begin on ${nextRaceDate} at 8:00 PM EST. Currently, the weather is: ${escapeHtml(conditionName(state.raceCenter.forecastCondition))}. Speed godspeed.</p>`;
  elements.feed.append(article);
}

function showEvent(event) {
  state.idleFeedKey = null;
  if (shouldRenderRaceState(event)) {
    elements.standings.innerHTML = standingsMarkup(event.standings);
    renderRacePodium(event.standings);
    renderRaceProgress(event.standings, event.time < 0 ? "Starting grid" : "Live lap");
    const leading = event.standings[0];
    elements.leader.textContent = event.time < 0
      ? "--"
      : entryById(leading.id).carName;
    const currentLap = Math.min(TOTAL_LAPS, leading.completedLaps + (leading.status === "finished" ? 0 : 1));
    elements.lap.textContent = event.type === "martyr-ceremony"
      ? "Pre-race ceremony"
      : `Leader lap ${currentLap}`;
  }
  addFeedItem(event);
}

async function finishRace() {
  clearInterval(state.timer);
  state.running = false;
  state.timer = null;
  state.elapsed = state.race.duration;
  elements.clock.textContent = formatRaceTime(state.elapsed);
  elements.lap.textContent = "Official result";
  renderRacePodium(state.race.finalStandings);
  renderRaceProgress([], "Awaiting next grid");
  if (!state.replay) {
    try {
      const response = await fetch(`/api/races/${state.race.id}/finish`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not close the race.");
      state.raceCenter = result;
      state.activeLeagueRace = null;
      renderRaceProgress([], "Awaiting next grid");
      await Promise.all([
        loadLeagueState(),
        loadDevelopment(),
        loadRacerDirectory(),
        loadRookieDraft(),
      ]);
      renderRaceArchive();
      renderDevelopment();
      renderLineupEditor();
      renderTeamProfile();
      renderLeague();
      renderRacerDirectories();
      renderRookieDraft();
      showSeasonCeremony({ automatic: true });
    } catch (error) {
      elements.developmentMessage.textContent = error.message;
    }
  }
  renderRaceControls();
  renderRaceTitle(state.race);
  elements.raceButton.disabled = true;
  elements.raceButton.textContent = "This race is over";
}

function tick() {
  const speed = Number(elements.speed.value);
  state.elapsed = -(state.race.preRaceDuration || 0)
    + (performance.now() - state.startedAt) / 1000 * speed;
  elements.clock.textContent = state.elapsed < 0
    ? `-${formatRaceTime(Math.abs(state.elapsed))}`
    : formatRaceTime(Math.min(state.elapsed, state.race.duration));
  elements.raceButton.textContent = state.replay
    ? "Replay in progress"
    : state.elapsed < 0
      ? "Race to begin shortly"
      : "Race in progress";
  if (state.elapsed < 0) elements.leader.textContent = "--";

  while (
    state.eventIndex < state.race.events.length
    && state.race.events[state.eventIndex].time <= Math.min(state.elapsed, state.race.duration)
  ) {
    showEvent(state.race.events[state.eventIndex]);
    state.eventIndex += 1;
  }

  if (state.elapsed >= 0 && state.elapsed < state.race.duration) {
    renderRaceProgress(
      interpolatedRaceProgressStandings(state.race, state.elapsed),
      "Live lap",
    );
  }

  if (state.elapsed >= state.race.duration) finishRace();
}

function playRace(race, replay = false, initialElapsed = null) {
  clearInterval(state.timer);
  state.race = race;
  state.idleFeedKey = null;
  state.elapsed = initialElapsed ?? -(race.preRaceDuration || 0);
  state.eventIndex = 0;
  state.running = true;
  state.replay = replay;
  if (!replay) state.activeLeagueRace = race;
  const speed = Number(elements.speed.value);
  state.startedAt = performance.now()
    - ((state.elapsed + (race.preRaceDuration || 0)) / speed) * 1000;
  elements.raceButton.disabled = true;
  elements.raceButton.textContent = replay
    ? "Replay in progress"
    : state.elapsed < 0
      ? "Race to begin shortly"
      : "Race in progress";
  renderRaceBanner();
  renderRaceTitle(race);
  elements.clock.textContent = state.elapsed < 0
    ? `-${formatRaceTime(Math.abs(state.elapsed))}`
    : "00:00";
  elements.leader.textContent = state.elapsed < 0 ? "--" : "Awaiting start";
  elements.lap.textContent = "Formation lap";
  elements.feed.innerHTML = "";
  renderInitialStandings(race.entries);
  renderRacePodium([]);
  renderRaceProgress(initialRaceProgressStandings(race.entries), state.elapsed < 0 ? "Starting grid" : "Live lap");
  state.timer = setInterval(tick, 100);
  tick();
}

async function startRace({ scheduledRaceAt = null } = {}) {
  if (state.running || !state.raceCenter.nextRaceNumber) return;
  if (!scheduledRaceAt && clearPreviewClock()) {
    window.location.reload();
    return;
  }
  elements.raceButton.disabled = true;
  elements.raceButton.textContent = "Generating race...";
  try {
    const response = await fetch("/api/races", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const race = await response.json();
    if (!response.ok) throw new Error(race.error || "Could not generate race.");
    await Promise.all([loadRaceCenter(), loadDevelopment()]);
    renderRaceArchive();
    renderDevelopment();
    renderLineupEditor();
    let initialElapsed = null;
    if (scheduledRaceAt) {
      elements.speed.value = "1";
      initialElapsed = Math.max(
        -(race.preRaceDuration || 0),
        (currentTimeMs() - scheduledRaceAt.getTime()) / 1000,
      );
    }
    playRace(race, false, initialElapsed);
  } catch (error) {
    if (scheduledRaceAt) {
      await loadRaceCenter();
      if (state.raceCenter.raceActive && state.raceCenter.activeRaceId) {
        const response = await fetch(`/api/races/${state.raceCenter.activeRaceId}`);
        const activeRace = await response.json();
        if (response.ok) {
          const initialElapsed = Math.max(
            -(activeRace.preRaceDuration || 0),
            (currentTimeMs() - scheduledRaceAt.getTime()) / 1000,
          );
          playRace(activeRace, false, initialElapsed);
          return;
        }
      }
    }
    elements.developmentMessage.textContent = error.message;
    renderRaceControls();
  }
}

function renderRaceControls() {
  if (state.running) {
    elements.raceButton.disabled = true;
    return;
  }
  const nextRace = state.raceCenter.nextRaceNumber;
  const martyrVoteRequired = state.raceCenter.seasonRacesRun === 0
    && state.martyr.status === "voting";
  const rookieDraftRequired = state.raceCenter.seasonRacesRun >= 10
    && state.rookieDraft.status !== "complete";
  const openingDraftRequired = state.raceCenter.season > 1
    && state.raceCenter.seasonRacesRun === 0
    && state.draft.status !== "complete";
  const openingSchedule = openingRaceSchedule();
  const awaitingOpeningCeremony = openingSchedule
    && currentDate() < openingSchedule.ceremonyAt;
  const awaitingScheduledRace = state.raceCenter.nextRaceAt
    && currentDate() < new Date(state.raceCenter.nextRaceAt)
    && !state.raceCenter.raceActive;
  elements.raceButton.disabled = !nextRace
    || state.raceCenter.raceActive
    || openingDraftRequired
    || martyrVoteRequired
    || rookieDraftRequired
    || awaitingOpeningCeremony
    || awaitingScheduledRace;
  elements.raceButton.textContent = state.raceCenter.raceActive
    ? "League race in progress"
    : openingDraftRequired
      ? "Opening draft required"
    : martyrVoteRequired
      ? "Initiation Martyr required"
    : awaitingOpeningCeremony
      ? "Awaiting Initiation Martyring"
    : awaitingScheduledRace
      ? "Awaiting scheduled race"
    : rookieDraftRequired
      ? state.rookieDraft.status === "voting"
        ? "Rookie draft vote required"
        : "Rookie draft required"
    : nextRace
      ? `Start ${weekdayName(nextRace)} race`
      : "Season complete";
  const managerAbbreviation = managerTeamAbbreviation();
  elements.seasonLabel.textContent = `${managerAbbreviation ? `${managerAbbreviation} / ` : ""}Season ${state.raceCenter.season} / Week ${state.raceCenter.week}`;
  elements.archiveSeasonLabel.textContent = `Season ${state.raceCenter.season} / Week ${state.raceCenter.week}`;
  elements.developmentWeek.textContent = `Week ${state.raceCenter.week}`;
  if (!state.running && !state.raceCenter.raceActive) {
    if (isPreRaceCardWindow() && !openingDraftRequired && !martyrVoteRequired && !rookieDraftRequired) {
      renderPreRaceCard();
    } else if (!renderHeldRaceCard()) {
      clearUpcomingRaceCard();
    }
  }
  renderRaceBanner();
  renderNewsTicker();
}

function formatNewsRaceDate(value) {
  if (!value) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value));
}

function newsForecastTerm(condition) {
  return {
    Raining: "Rain",
    Snowing: "Snow",
    Churning: "Churn",
  }[condition] || condition || "Sunny";
}

function nextScheduledSeasonRaceNumber() {
  return state.raceCenter.seasonRacesRun + 1;
}

function nextRaceNewsText() {
  const seasonRaceNumber = nextScheduledSeasonRaceNumber();
  return `Next race: ${state.raceCenter.trackName || "TBD"} // Race ${seasonRaceNumber} of ${state.raceCenter.seasonRaces} // ${formatNewsRaceDate(state.raceCenter.nextRaceAt)} // Forecast: ${newsForecastTerm(state.raceCenter.forecastCondition)}`;
}

function calibrateNewsTicker({ restart = false } = {}) {
  const track = elements.newsTickerText;
  const ticker = track?.closest(".news-ticker");
  const firstMessage = track?.querySelector("span");
  if (!track || !ticker || !firstMessage) return;
  if (ticker.offsetParent === null || ticker.getBoundingClientRect().width === 0) {
    return;
  }
  window.requestAnimationFrame(() => {
    const messageWidth = firstMessage.getBoundingClientRect().width;
    const tickerWidth = ticker.getBoundingClientRect().width;
    if (!messageWidth || !tickerWidth) return;
    const trackStart = parseFloat(window.getComputedStyle(track).marginLeft) || 0;
    const gap = Math.max(108, tickerWidth - messageWidth - trackStart);
    const distance = messageWidth + gap;
    const pixelsPerSecond = 95;
    const duration = Math.max(4.5, distance / pixelsPerSecond);
    const priorDistance = Number.parseFloat(track.dataset.tickerDistance || "0");
    const priorGap = Number.parseFloat(track.dataset.tickerGap || "0");
    const changedMeaningfully = Math.abs(priorDistance - distance) > 1
      || Math.abs(priorGap - gap) > 1;
    track.style.setProperty("--ticker-gap", `${gap}px`);
    track.style.setProperty("--ticker-distance", `${distance}px`);
    track.style.setProperty("--ticker-duration", `${duration}s`);
    track.dataset.tickerDistance = String(distance);
    track.dataset.tickerGap = String(gap);
    if (restart || (changedMeaningfully && !track.dataset.tickerCalibrated)) {
      track.style.animation = "none";
      track.offsetHeight;
      track.style.animation = "";
    }
    track.dataset.tickerCalibrated = "true";
  });
}

function renderNewsTicker() {
  if (!elements.newsTickerText) return;
  let text = "";
  if (state.raceCenter.raceActive) {
    const activeRace = state.activeLeagueRace;
    const raceNumber = activeRace
      ? ((activeRace.week - 1) * state.raceCenter.racesPerWeek) + activeRace.raceNumber
      : state.raceCenter.seasonRacesRun;
    text = activeRace
      ? `Current race: ${activeRace.courseName} // Race ${raceNumber} of ${state.raceCenter.seasonRaces} // Conditions: ${activeRace.condition}`
      : "Race in progress.";
  } else if (
    state.raceCenter.seasonRacesRun === 0
    && state.draft.status === "not_started"
  ) {
    text = "Vote to begin the season.";
  } else if (state.draft.status === "active") {
    const team = teams.find((item) => item.id === state.draft.currentTeamId);
    text = `Opening draft: ${team ? `${team.short} / ${team.name}` : "A team"} is on the clock.`;
  } else if (
    state.raceCenter.seasonRacesRun === 0
    && state.draft.status === "complete"
    && state.martyr.status !== "resolved"
  ) {
    text = "A martyr must be chosen.";
  } else if (state.rookieDraft.status === "active") {
    const team = teams.find((item) => item.id === state.rookieDraft.currentTeamId);
    text = `Rookie draft: ${team ? `${team.short} / ${team.name}` : "A team"} is on the clock.`;
  } else if (state.rookieDraft.status === "voting") {
    text = "Vote to begin the rookie draft.";
  } else if (state.rookieDraft.status === "releases") {
    const awaiting = state.rookieDraft.teamsAwaitingRelease || [];
    text = `Roster releases required: ${awaiting.map((teamId) => teams.find((team) => team.id === teamId)?.short || teamId).join(", ")}.`;
  } else if (state.raceCenter.seasonComplete) {
    text = "Season complete. Champions crowned.";
  } else {
    text = nextRaceNewsText();
  }
  if (elements.newsTickerText.dataset.message === text) {
    return;
  }
  elements.newsTickerText.dataset.message = text;
  elements.newsTickerText.innerHTML = `
    <span>${escapeHtml(text)}</span>
    <span aria-hidden="true">${escapeHtml(text)}</span>
  `;
  delete elements.newsTickerText.dataset.tickerCalibrated;
  delete elements.newsTickerText.dataset.tickerDistance;
  delete elements.newsTickerText.dataset.tickerGap;
  calibrateNewsTicker({ restart: true });
}

function stabilizeInitialLayout() {
  window.requestAnimationFrame(() => {
    if (
      elements.rulesPage?.hidden !== false
      && elements.mediaPage?.hidden !== false
      && !["rules", "media"].includes(readNavigationState().mode)
    ) {
      activateSection(state.activeSection, state.activeViewBySection[state.activeSection]);
    }
    calibrateNewsTicker();
    window.requestAnimationFrame(calibrateNewsTicker);
  });
}

function renderRaceBanner() {
  const activeRace = state.raceCenter.raceActive ? state.activeLeagueRace : null;
  if (activeRace) {
    const activeDay = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: "America/New_York",
    }).format(new Date(activeRace.startAt));
    elements.raceBannerTitle.textContent = `Current Race: ${activeRace.courseName} / Week ${activeRace.week} / ${activeDay}`;
    elements.raceBannerCondition.textContent = `Conditions: ${activeRace.condition}`;
    return;
  }

  const trackName = state.raceCenter.trackName;
  const track = courseByName(trackName);
  elements.raceBannerTitle.textContent = `Next Course: ${trackName}`;
  const forecastCondition = state.raceCenter.forecastCondition
    || Object.keys(track.conditionLikelihoods)[0];
  const forecastTerms = {
    Raining: "Rain",
    Snowing: "Snow",
    Churning: "Churn",
  };
  elements.raceBannerCondition.textContent = `Forecast: ${forecastTerms[forecastCondition] || forecastCondition}`;
}

function weekdayName(raceNumber) {
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][raceNumber - 1]
    || `Race ${raceNumber}`;
}

function renderRaceArchive() {
  closeRaceReview();
  elements.raceHistory.innerHTML = state.raceCenter.races.length
    ? state.raceCenter.races.map((race) => {
      const winner = teams.find((team) => team.id === race.winner_team_id);
      return `
        <article class="race-record">
          <div>
            <span class="race-record-number">Week ${race.week} / ${weekdayName(race.race_number)}</span>
            <strong>${escapeHtml(race.course_name)}</strong>
            <p>${escapeHtml(race.winner_car)} won for ${winner.short}. The race concluded after ${formatRaceTime(race.duration)}.</p>
          </div>
          <button data-review-race="${race.id}">Review</button>
        </article>`;
    }).join("")
    : `<p class="muted">No races have been run. The archive is listening.</p>`;

  const pointsLabel = (points) => Number.isInteger(points)
    ? String(points)
    : Number(points.toFixed(2)).toString();
  elements.standingsSeasonLabel.textContent = `Season ${state.raceCenter.season} standings`;
  const champions = state.raceCenter.champions;
  elements.seasonChampions.hidden = !champions;
  if (champions) {
    const teamNames = champions.teams.map((champion) => {
      const team = teams.find((item) => item.id === champion.teamId);
      return team?.name || champion.teamId;
    }).join(" / ");
    const mvdNames = champions.mvds.map((champion) => champion.racerName).join(" / ");
    const nextSeasonButton = isStewardManager()
      ? `<button type="button" class="primary-button begin-next-season" data-begin-next-season>Begin Season ${state.raceCenter.season + 1}</button>`
      : "";
    elements.seasonChampions.innerHTML = `
      <div class="season-champions-heading">
        <span class="eyebrow">Official season record</span>
        <h2>Season ${state.raceCenter.season} Crowned</h2>
      </div>
      <div class="season-champion-grid">
        <div class="season-champion">
          <span>Team Champion${champions.teams.length > 1 ? "s" : ""}</span>
          <strong>${escapeHtml(teamNames)}</strong>
        </div>
        <div class="season-champion">
          <span>MVD${champions.mvds.length > 1 ? "s" : ""}</span>
          <strong>${escapeHtml(mvdNames)}</strong>
        </div>
      </div>
      ${nextSeasonButton}`;
  } else {
    elements.seasonChampions.innerHTML = "";
  }
  elements.championship.innerHTML = state.raceCenter.championship.map((standing) => {
    const team = teams.find((item) => item.id === standing.teamId);
    return `
      <div class="championship-row">
        <span class="position">${String(standing.rank).padStart(2, "0")}</span>
        <i class="team-stripe" style="background:${team?.color || "var(--line)"}"></i>
        <strong>${escapeHtml(team?.name || standing.teamId)}</strong>
        <span>${pointsLabel(standing.points)} pts</span>
      </div>`;
  }).join("");
  elements.mvdStandings.innerHTML = state.raceCenter.mvdStandings.map((standing) => `
    <div class="championship-row">
      <span class="position">${String(standing.rank).padStart(2, "0")}</span>
      <i class="team-stripe" style="background:${teams.find((team) => team.id === standing.teamId)?.color || "var(--line)"}"></i>
      <strong>${escapeHtml(standing.racerName)}</strong>
      <span>${pointsLabel(standing.points)} pts</span>
    </div>
  `).join("");
}

function seasonCeremonyStorageKey() {
  const champions = state.raceCenter.champions;
  const latestSeasonRaceId = Math.max(
    0,
    ...state.raceCenter.races
      .filter((race) => race.season === state.raceCenter.season)
      .map((race) => Number(race.id) || 0),
  );
  const teamSignature = champions?.teams
    ?.map((champion) => `${champion.teamId}:${Number(champion.points || 0).toFixed(2)}`)
    .join("|") || "none";
  const mvdSignature = champions?.mvds
    ?.map((champion) => `${champion.racerId}:${Number(champion.points || 0).toFixed(2)}`)
    .join("|") || "none";
  return `asscar60-season-${state.raceCenter.season}-race-${latestSeasonRaceId}-ceremony-${teamSignature}-${mvdSignature}-seen`;
}

function isSeasonCeremonyPreview() {
  return new URLSearchParams(window.location.search).get("preview") === "season-ceremony";
}

function applySeasonCeremonyPreview() {
  if (!isSeasonCeremonyPreview()) return;
  const championTeam = teams.find((team) => team.id === "brass") || teams[0];
  const mvdRacer = state.racerDirectory.signed.find(
    (racer) => racer.team_id === "archive" && racer.team_id !== championTeam.id,
  ) || state.racerDirectory.signed.find((racer) => racer.team_id !== championTeam.id);
  state.raceCenter.champions = {
    teams: [{
      teamId: championTeam.id,
      points: 312,
      rank: 1,
    }],
    mvds: [{
      racerId: mvdRacer?.id || "preview-mvd",
      racerName: mvdRacer?.name || "Quill October",
      teamId: mvdRacer?.team_id || "archive",
      points: 184.5,
      rank: 1,
    }],
  };
}

function showSeasonCeremony({ automatic = false } = {}) {
  const champions = state.raceCenter.champions;
  if (!champions || elements.seasonCeremonyDialog.open) return;
  if (automatic) {
    try {
      if (localStorage.getItem(seasonCeremonyStorageKey()) === "true") return;
    } catch {
      // The ceremony still works when browser storage is unavailable.
    }
  }

  elements.seasonCeremonySeason.textContent = `ASSCAR60 / Season ${state.raceCenter.season}`;
  const teamHonors = champions.teams.map((champion) => {
    const team = teams.find((item) => item.id === champion.teamId);
    return `
      <article class="season-ceremony-honor" style="--honor-color:${team?.color || "var(--acid)"}">
        <span>Team Champion${champions.teams.length > 1 ? "s" : ""}</span>
        <strong>${escapeHtml(team?.name || champion.teamId)}</strong>
        <small>${Number(champion.points.toFixed(2))} championship points</small>
      </article>`;
  }).join("");
  const mvdHonors = champions.mvds.map((champion) => {
    const team = teams.find((item) => item.id === champion.teamId);
    return `
      <article class="season-ceremony-honor" style="--honor-color:${team?.color || "var(--acid)"}">
        <span>MVD / Most Valuable Driver</span>
        <strong>${escapeHtml(champion.racerName)}</strong>
        <small>${Number(champion.points.toFixed(2))} MVD points</small>
      </article>`;
  }).join("");
  elements.seasonCeremonyHonors.innerHTML = teamHonors + mvdHonors;
  elements.seasonCeremonyDialog.showModal();
}

function closeSeasonCeremony() {
  try {
    localStorage.setItem(seasonCeremonyStorageKey(), "true");
  } catch {
    // Closing the ceremony must not depend on browser storage.
  }
  elements.seasonCeremonyDialog.close();
}

function courseFeatureMarkup(label, segments) {
  const severities = segments.map((segment) => segment.severity);
  return `
    <div class="course-feature">
      <span>${label}</span>
      <strong>${segments.length}</strong>
      <small>${severities.length ? `Severity ${severities.join(", ")}` : "None"}</small>
    </div>`;
}

function renderCourses() {
  elements.courseList.innerHTML = COURSES.map((course, index) => {
    const summary = courseSummary(course);
    const turns = course.segments.filter((segment) => segment.type === "turn");
    const chicanes = course.segments.filter((segment) => segment.type === "chicane");
    const roleMedians = state.raceCenter.lapPerformance?.courseRoleMedians?.[course.name] || {};
    return `
      <article class="course-card ${state.raceCenter.week === index + 1 ? "current" : ""}">
        <div class="course-card-heading">
          <span class="course-week">Week ${index + 1}</span>
          <h3>${escapeHtml(course.name)}</h3>
          <span class="course-length">Length ${course.length} / 5</span>
        </div>
        <div class="course-features">
          <div class="course-feature">
            <span>Straights</span>
            <strong>${summary.straights}</strong>
            <small>Overtake zones</small>
          </div>
          ${courseFeatureMarkup("Turns", turns)}
          ${courseFeatureMarkup("Chicanes", chicanes)}
        </div>
        <div class="course-performance">
          <span class="card-label">Role benchmarks</span>
          <div class="performance-grid compact">
            ${["Opener", "Bridge", "Closer"].map((role) => `
              <div class="performance-tile">
                <span>ALR-${ROLE_CODES[role]}</span>
                <strong>${formatPerformanceTime(roleMedians[role])}</strong>
                <small>${role} median</small>
              </div>
            `).join("")}
          </div>
        </div>
      </article>`;
  }).join("");
}

function renderTeamPicker() {
  state.selectedTeamId = managedTeamId();
}

function renderTeamProfile() {
  const team = teams.find((item) => item.id === state.selectedTeamId) || managedTeam();
  elements.teamProfile.innerHTML = `
    <article class="team-profile" data-short="${team.short}" style="background:${team.accent};border:1px solid ${team.color}">
      <h2>${team.name}</h2>
    </article>
    <div class="roster-grid racer-directory roster-directory">
      ${team.drivers.map((driver) => racerDirectoryCard(driverWithDirectoryData(driver), {
        showAffiliation: false,
      })).join("")}
    </div>`;
}

function driverWithDirectoryData(driver) {
  const directoryRacer = [...state.racerDirectory.signed, ...state.racerDirectory.freeAgents]
    .find((racer) => racer.id === driver.id);
  return {
    ...driver,
    ...directoryRacer,
  };
}

function racerIdentityMarkup(racer) {
  return `
    <div class="racer-identity">
      <strong>${escapeHtml(racer.name)}</strong>
      <span>${escapeHtml(racer.pronouns)}</span>
    </div>`;
}

function renderGarageCars() {
  const team = teams.find((item) => item.id === state.selectedTeamId) || managedTeam();
  const carNames = state.carNames[team.id] || defaultCarNames(team);
  const cars = state.cars[team.id] || [];
  elements.garageCars.innerHTML = carNames.map((carName, index) => `
    <article class="garage-car panel" style="--team-color:${team.color}">
      <span class="garage-car-number">Car ${index + 1}</span>
      <div class="garage-car-name" data-car-editor="${index}">
        <h2><span>${team.short}</span> <strong data-car-display="${index}">${escapeHtml(carName)}</strong></h2>
        <input type="text" maxlength="32" value="${escapeAttribute(carName)}" data-car-input="${index}" aria-label="${team.short} car ${index + 1} name" hidden>
        <button type="button" class="edit-car-name" data-edit-garage-car="${index}" aria-label="Edit ${team.short} ${escapeAttribute(carName)} name" title="Edit car name" ${state.raceCenter.raceActive ? "disabled" : ""}>
          <span aria-hidden="true">&#9998;</span>
        </button>
      </div>
      <p>Registered to ${team.name}. Both machines began as identical team-standard chassis.</p>
      <p class="save-message" data-car-message="${index}"></p>
      ${carStatsMarkup(cars[index])}
    </article>
  `).join("");
}

function carStatsMarkup(car = {}) {
  const stats = [
    ["SPD", car.speed ?? 3, "Speed"],
    ["HDL", car.handling ?? 3, "Handling"],
    ["DUR", car.durability ?? 3, "Durability"],
    ["FDB", car.feedback ?? 3, "Feedback"],
    ["WRD", car.weird ?? 3, "Weird"],
  ];
  return `
    <div class="car-ratings">
      ${stats.map(([abbreviation, value, label]) => `
        <span class="rating" title="${label}">
          <span class="rating-label">${abbreviation}</span>
          <strong class="rating-value">${value}</strong>
        </span>
      `).join("")}
    </div>`;
}

function relayPerformanceMarkup(driverId, role) {
  const courseName = state.raceCenter.trackName || COURSES[0].name;
  const courseCode = COURSE_CODES[courseName];
  const roleCode = ROLE_CODES[role];
  const performance = racerPerformance(driverId);
  if (!courseCode || !roleCode || !performance) {
    return `<div class="relay-performance muted">No lap data yet.</div>`;
  }
  const courseKey = `ALC-${courseCode}`;
  const roleKey = `ALR-${roleCode}`;
  const vsKey = `V${courseCode}${roleCode}`;
  return `
    <div class="relay-performance">
      <span title="Average Lap Time by Course">${courseKey} ${formatPerformanceTime(performance.courses?.[courseKey])}</span>
      <span title="Average Lap Time by Role">${roleKey} ${formatPerformanceTime(performance.roles?.[roleKey])}</span>
      <span class="${Number(performance.vsCourseRole?.[vsKey]) < 0 ? "good" : Number(performance.vsCourseRole?.[vsKey]) > 0 ? "bad" : ""}" title="Driver Average Vs Course/Role Median">${vsKey} ${formatPerformanceDelta(performance.vsCourseRole?.[vsKey])}</span>
    </div>`;
}

function renderLineupEditor() {
  const team = teams.find((item) => item.id === state.selectedTeamId) || managedTeam();
  const selections = state.lineups[team.id] || defaultLineup(team);
  const carNames = state.carNames[team.id] || defaultCarNames(team);
  if (!team.drivers.length) {
    elements.lineupEditor.innerHTML = `
      <div class="draft-complete">Your garage is awaiting the opening draft before relay plans can be set.</div>
    `;
    elements.saveLineup.disabled = true;
    elements.saveMessage.textContent = "";
    return;
  }
  const raceLockReason = relayPlanRaceLockReason();
  if (raceLockReason) state.relayPlanEditing = false;
  elements.lineupEditor.innerHTML = [0, 1].map((carIndex) => `
    <div class="car-lineup" data-car="${carIndex}">
      <div class="car-lineup-heading">
        <div class="car-name-control">
          <span class="car-prefix">${team.short}</span>
          <strong class="car-name-text">${escapeHtml(carNames[carIndex])}</strong>
        </div>
        <span class="stint-total" data-total="${carIndex}">60 / 60 laps</span>
      </div>
      ${["Opener", "Bridge", "Closer"].map((stintRole, stintIndex) => {
        const slot = carIndex * 3 + stintIndex;
        const selection = selections[slot];
        return `
          <div class="stint-row">
            <span class="stint-label">${stintRole}</span>
            <select data-driver-slot="${slot}" aria-label="${team.short} car ${carIndex + 1} stint ${stintIndex + 1} driver">
              ${team.drivers.map((driver) => `
                <option value="${driver.id}" ${driver.id === selection?.driverId ? "selected" : ""}>${driver.name}</option>
              `).join("")}
            </select>
            ${relayPerformanceMarkup(selection?.driverId, stintRole)}
            <label class="length-control">
              <span>Length</span>
              <input type="number" min="5" max="40" step="1" value="${selection?.laps ?? 20}" data-laps-slot="${slot}" aria-label="${team.short} car ${carIndex + 1} stint ${stintIndex + 1} length">
              <span>laps</span>
            </label>
          </div>`;
      }).join("")}
    </div>`).join("");
  updateStintRanges();
  const locked = Boolean(raceLockReason) || !state.relayPlanEditing;
  elements.lineupEditor.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = locked;
  });
  elements.saveLineup.classList.toggle("locked", !state.relayPlanEditing && !raceLockReason);
  elements.saveLineup.textContent = state.relayPlanEditing ? "Save Plan" : "Edit Plan";
  updateLineupEligibility();
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function updateStintRanges() {
  [0, 1].forEach((carIndex) => {
    let total = 0;
    for (let stintIndex = 0; stintIndex < 3; stintIndex += 1) {
      const slot = carIndex * 3 + stintIndex;
      const input = elements.lineupEditor.querySelector(`[data-laps-slot="${slot}"]`);
      const laps = Number(input.value) || 0;
      total += laps;
    }
    const totalElement = elements.lineupEditor.querySelector(`[data-total="${carIndex}"]`);
    totalElement.textContent = `${total} / 60 laps`;
    totalElement.classList.toggle("invalid", total !== 60);
  });
  updateLineupEligibility();
}

function currentLineupAssignments() {
  return [...Array(6)].map((_, slot) => ({
    driverId: elements.lineupEditor.querySelector(`[data-driver-slot="${slot}"]`)?.value || "",
    laps: Number(elements.lineupEditor.querySelector(`[data-laps-slot="${slot}"]`)?.value),
  }));
}

function lineupIneligibilityReason(assignments) {
  const raceLockReason = relayPlanRaceLockReason();
  if (raceLockReason) return raceLockReason;
  if (!state.relayPlanEditing) return "";
  if (assignments.some((assignment) => assignment.laps < 5 || assignment.laps > 40)) {
    return "Every stint must be between 5 and 40 laps.";
  }
  const totals = [0, 1].map((carIndex) => assignments
    .slice(carIndex * 3, carIndex * 3 + 3)
    .reduce((sum, assignment) => sum + assignment.laps, 0));
  if (totals.some((total) => total !== TOTAL_LAPS)) {
    return "Each car's three stints must total exactly 60 laps.";
  }
  const driverIds = assignments.map((assignment) => assignment.driverId);
  if (new Set(driverIds).size !== 6) {
    return "A racer can only appear once across the team's two relay plans.";
  }
  return "";
}

function updateLineupEligibility() {
  const reason = lineupIneligibilityReason(currentLineupAssignments());
  const raceLockReason = relayPlanRaceLockReason();
  elements.saveLineup.disabled = Boolean(raceLockReason)
    || (state.relayPlanEditing && Boolean(reason));
  elements.saveLineup.classList.toggle("locked", !state.relayPlanEditing && !raceLockReason);
  elements.saveLineup.textContent = state.relayPlanEditing ? "Save Plan" : "Edit Plan";
  elements.saveMessage.classList.toggle("error", Boolean(reason));
  elements.saveMessage.textContent = reason;
  return !reason;
}

function renderLeague() {
  const pointsByTeam = new Map(
    state.raceCenter.championship.map((standing) => [standing.teamId, standing.points]),
  );
  elements.teamGrid.innerHTML = teams.map((team) => {
    const racers = state.racerDirectory.signed.filter((racer) => racer.team_id === team.id);
    const points = pointsByTeam.get(team.id) || 0;
    const titles = state.raceCenter.teamChampionshipWins?.[team.id] || 0;
    return `
      <article class="league-card" style="--team-color:${team.color}">
        <span class="code">${escapeHtml(team.short)}</span>
        <h3>${escapeHtml(team.name)}</h3>
        <div class="league-team-record">
          <span><strong>${points}</strong> Current points</span>
          <span><strong>${titles}</strong> Championship wins</span>
        </div>
        <div class="league-roster">
          <span class="card-label">Current drivers</span>
          ${racers.map((racer) => `
            <button type="button" data-team-racer="${racer.id}">${escapeHtml(racer.name)}</button>
          `).join("")}
        </div>
      </article>`;
  }).join("");
}

function contrastColor(hex) {
  const value = String(hex).replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.52 ? "#ffffff" : "#08100d";
}

function lightTeamColor(hex) {
  const value = String(hex).replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `rgb(${channels.map((channel) => Math.round((channel * 0.32) + (12 * 0.68))).join(", ")})`;
}

function applyTeamTheme(teamId = state.selectedTeamId) {
  const team = teams.find((item) => item.id === teamId) || teams[0];
  document.documentElement.style.setProperty("--acid", team.color);
  document.documentElement.style.setProperty("--acid-ink", contrastColor(team.color));
  document.documentElement.style.setProperty("--team-soft", lightTeamColor(team.color));
}

function renderBrand() {
  const actingTeamId = managedTeamId();
  const team = teams.find((item) => item.id === actingTeamId) || teams[0];
  const brand = state.brands[team.id] || {};
  const usedColors = new Map(
    Object.values(state.brands).map((item) => [item.color, item.team_id]),
  );
  elements.brandTeam.textContent = managedTeamLabel();

  const lockText = (changedSeason) => changedSeason === state.raceCenter.season
    ? `Changed in Season ${state.raceCenter.season}`
    : "Available this season";
  elements.brandEditor.innerHTML = `
    <article class="brand-card panel">
      <span class="brand-status">${lockText(brand.name_changed_season)}</span>
      <h2>Team name</h2>
      <p class="brand-current">${escapeHtml(team.name)}</p>
      <input type="text" maxlength="40" value="${escapeAttribute(team.name)}"
        data-brand-value="name" aria-label="New team name"
        ${brand.name_changed_season === state.raceCenter.season ? "disabled" : ""}>
      <button class="primary-button" data-save-brand="name"
        ${brand.name_changed_season === state.raceCenter.season ? "disabled" : ""}>
        Change team name
      </button>
    </article>
    <article class="brand-card panel">
      <span class="brand-status">${lockText(brand.abbreviation_changed_season)}</span>
      <h2>3 Character Abbreviation</h2>
      <p class="brand-current">${escapeHtml(team.short)}</p>
      <input type="text" minlength="3" maxlength="3" pattern="[A-Za-z0-9]{3}"
        value="${escapeAttribute(team.short)}"
        data-brand-value="abbreviation" aria-label="New 3 character team abbreviation"
        ${brand.abbreviation_changed_season === state.raceCenter.season ? "disabled" : ""}>
      <button class="primary-button" data-save-brand="abbreviation"
        ${brand.abbreviation_changed_season === state.raceCenter.season ? "disabled" : ""}>
        Change abbreviation
      </button>
      <p class="save-message error brand-field-message" data-brand-error="abbreviation" role="status"></p>
    </article>
    <article class="brand-card brand-color-card panel">
      <span class="brand-status">Available anytime</span>
      <h2>Team color</h2>
      <p class="brand-current"><i class="brand-color-preview" style="background:${team.color}"></i>${team.color}</p>
      <div class="brand-palette">
        ${state.brandColors.map((color) => {
          const owner = usedColors.get(color);
          const unavailable = owner && owner !== team.id;
          return `
            <label class="brand-swatch ${unavailable ? "unavailable" : ""}"
              style="--swatch:${color};--swatch-ink:${contrastColor(color)}"
              title="${unavailable ? "Already used by another team" : color}">
              <input type="radio" name="brand-color" value="${color}"
                ${color === team.color ? "checked" : ""}
                ${unavailable ? "disabled" : ""}>
              <span>${color === team.color ? "Current" : unavailable ? "Used" : "Select"}</span>
            </label>`;
        }).join("")}
      </div>
      <button class="primary-button" data-save-brand="color">
        Change team color
      </button>
      <p class="save-message error brand-field-message" data-brand-error="color" role="status"></p>
    </article>`;
  updateAbbreviationEligibility();
  updateColorEligibility();
}

function updateAbbreviationEligibility() {
  const input = elements.brandEditor.querySelector('[data-brand-value="abbreviation"]');
  const button = elements.brandEditor.querySelector('[data-save-brand="abbreviation"]');
  const message = elements.brandEditor.querySelector('[data-brand-error="abbreviation"]');
  if (!input || !button || !message) return;

  const team = managedTeam();
  const brand = state.brands[team?.id] || {};
  const locked = brand.abbreviation_changed_season === state.raceCenter.season;
  const invalidLength = !/^[A-Za-z0-9]{3}$/.test(input.value.trim());
  button.disabled = locked || invalidLength;
  message.textContent = !locked && invalidLength
    ? "The abbreviation must contain exactly 3 letters or numbers."
    : "";
}

function updateColorEligibility() {
  const button = elements.brandEditor.querySelector('[data-save-brand="color"]');
  const message = elements.brandEditor.querySelector('[data-brand-error="color"]');
  const selected = elements.brandEditor.querySelector('input[name="brand-color"]:checked');
  if (!button || !message || !selected) return;

  const team = managedTeam();
  const unchanged = selected.value === team.color;
  button.disabled = unchanged;
  message.textContent = unchanged
    ? "Choose a different color before saving."
    : "";
}

function racerDirectoryCard(racer, { showAffiliation = true } = {}) {
  const team = teams.find((item) => item.id === racer.team_id);
  const affiliation = team ? `${team.short} / ${team.name}` : "Unsigned free agent";
  const career = racer.career || {
    races: 0,
    laps: 0,
    wins: 0,
    podiums: 0,
    bestFinish: null,
    mvds: 0,
  };
  const bestFinish = career.bestFinish ? `P${career.bestFinish}` : "None";
  return `
    <article class="directory-racer" data-racer-card="${racer.id}">
      <button class="directory-racer-summary" type="button" data-expand-racer="${racer.id}" aria-expanded="false">
        <span>
          ${racerIdentityMarkup(racer)}
          ${showAffiliation ? `<small>${escapeHtml(affiliation)}</small>` : ""}
        </span>
        <span class="directory-expand-label">View profile</span>
      </button>
      ${statTilesMarkup(racer)}
      <div class="racer-expanded" hidden>
        <div class="racer-bio">
          <span class="card-label">Additional racer data</span>
          <dl>
            <div><dt>Status</dt><dd>${escapeHtml(affiliation)}</dd></div>
            <div><dt>League origin</dt><dd>${escapeHtml(racer.leagueOrigin)}</dd></div>
            <div><dt>Potential remaining</dt><dd>${racer.potential}</dd></div>
          </dl>
        </div>
        <div class="career-stats">
          <span class="card-label">Career statistics</span>
          <div class="career-grid">
            <div><strong>${career.races}</strong><span>Races</span></div>
            <div><strong>${career.laps}</strong><span>Scheduled laps</span></div>
            <div><strong>${career.wins}</strong><span>Wins</span></div>
            <div><strong>${career.podiums}</strong><span>Podiums</span></div>
            <div><strong>${bestFinish}</strong><span>Best finish</span></div>
            <div><strong>${career.mvds}</strong><span>MVDs</span></div>
          </div>
        </div>
        ${racerPerformanceProfileMarkup(racer)}
        ${racerRecentRaceMarkup(racer)}
      </div>
    </article>`;
}

function racerRecentRaceMarkup(racer) {
  const recent = racer.recentRace;
  if (!recent) {
    return `
      <div class="racer-recent-race">
        <span class="card-label">Most Recent Race</span>
        <p class="muted">No race data recorded for this racer in the current season.</p>
      </div>`;
  }
  return `
    <div class="racer-recent-race">
      <span class="card-label">Most Recent Race</span>
      <div class="recent-race-heading">
        <strong>${escapeHtml(recent.courseName)}</strong>
        <span>Week ${recent.week} / Race ${recent.raceNumber}</span>
      </div>
      <div class="performance-grid recent-race-grid">
        ${performanceTileMarkup("MISH", recent.mishaps, "Mishaps")}
        ${performanceTileMarkup("OTP", recent.overtakeParticipations, "Overtakes participated")}
        ${performanceTileMarkup("SOA", recent.successfulOvertakeAttacks, "Successful attacks")}
        ${performanceTileMarkup("SOD", recent.successfulOvertakeDefends, "Successful defends")}
        ${performanceTileMarkup("F5", formatPerformanceTime(recent.firstFiveLapAverage), "First 5 lap avg")}
        ${performanceTileMarkup("L5", formatPerformanceTime(recent.lastFiveLapAverage), "Last 5 lap avg")}
      </div>
    </div>`;
}

function racerPerformanceProfileMarkup(racer) {
  const performance = racer.performance || {};
  const courseTiles = COURSES.map((course) => {
    const key = `ALC-${COURSE_CODES[course.name]}`;
    return performanceTileMarkup(key, formatPerformanceTime(performance.courses?.[key]), course.name);
  }).join("");
  const roleTiles = Object.keys(ROLE_CODES).map((role) => {
    const key = `ALR-${ROLE_CODES[role]}`;
    return performanceTileMarkup(key, formatPerformanceTime(performance.roles?.[key]), role);
  }).join("");
  const vsRows = COURSES.map((course) => `
    <div class="performance-vs-row">
      <span>${escapeHtml(course.name)}</span>
      ${Object.keys(ROLE_CODES).map((role) => {
        const key = `V${COURSE_CODES[course.name]}${ROLE_CODES[role]}`;
        const value = performance.vsCourseRole?.[key];
        return `<strong class="${Number(value) < 0 ? "good" : Number(value) > 0 ? "bad" : ""}">${key} ${formatPerformanceDelta(value)}</strong>`;
      }).join("")}
    </div>
  `).join("");
  return `
    <div class="racer-performance-profile">
      <span class="card-label">Lap performance</span>
      <div class="performance-grid">
        ${performanceTileMarkup("ALT", formatPerformanceTime(performance.ALT), "Average Lap Time")}
      </div>
      <div class="performance-section">
        <small>Average Lap Time by Course / ALC-@</small>
        <div class="performance-grid">${courseTiles}</div>
      </div>
      <div class="performance-section">
        <small>Average Lap Time by Role / ALR-@</small>
        <div class="performance-grid">${roleTiles}</div>
      </div>
      <div class="performance-section">
        <small>Driver Average Vs Course/Role Median / V@@</small>
        <div class="performance-vs-grid">${vsRows}</div>
      </div>
    </div>`;
}

function performanceTileMarkup(label, value, description) {
  return `
    <div class="performance-tile">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${escapeHtml(description)}</small>
    </div>`;
}

function renderRacerDirectories() {
  const signed = sortRacers(state.racerDirectory.signed, elements.signedRacerSort.value);
  const freeAgents = sortRacers(
    state.racerDirectory.freeAgents,
    elements.freeAgentRacerSort.value,
  );
  elements.signedRacers.innerHTML = signed.length
    ? signed.map(racerDirectoryCard).join("")
    : `<p class="muted">No racers are currently signed.</p>`;
  elements.freeAgentRacers.innerHTML = freeAgents.length
    ? freeAgents.map(racerDirectoryCard).join("")
    : `<p class="muted">No free agents are currently available.</p>`;
}

function renderInMemoriam() {
  elements.memoriamList.innerHTML = state.inMemoriam.length
    ? state.inMemoriam.map((entry) => `
      <article class="memoriam-row">
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${escapeHtml(entry.cause)}</span>
      </article>
    `).join("")
    : `<p class="muted">No ASSCAR60 deaths have been recorded.</p>`;
}

function formatMediaDate(value) {
  if (!value) return "Date unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function mediaBodyMarkup(body) {
  return escapeHtml(body).split(/\n{2,}/).map((paragraph) => (
    `<p>${paragraph.replace(/\n/g, "<br>")}</p>`
  )).join("");
}

function canModifyMediaEntry(entry) {
  return isStewardManager() || entry.authorUsername === state.managerUsername;
}

function hasUnreadMediaEntries() {
  return Boolean(state.unreadMediaEntryIds?.length);
}

function updateMediaAlertBadges() {
  const hasUnread = hasUnreadMediaEntries();
  elements.appMenuButton?.classList.toggle("has-alert", hasUnread && !state.mediaMenuNoticed);
  elements.openMedia?.classList.toggle("has-alert", hasUnread && state.mediaMenuNoticed);
}

function renderMediaPage() {
  if (!elements.mediaList) return;
  updateMediaAlertBadges();
  if (!state.mediaEntries.length) {
    elements.mediaList.innerHTML = `<p class="muted">No media entries have been published yet.</p>`;
    return;
  }
  const unreadIds = new Set(state.unreadMediaEntryIds || []);
  elements.mediaList.innerHTML = state.mediaEntries.map((entry) => {
    const expanded = state.expandedMediaEntryId === entry.id;
    const canModify = canModifyMediaEntry(entry);
    const unread = unreadIds.has(entry.id);
    return `
      <article class="media-entry ${expanded ? "expanded" : ""}" data-media-entry="${entry.id}">
        <button type="button" class="media-entry-summary ${unread && !expanded ? "has-alert" : ""}" data-media-toggle="${entry.id}">
          <span>
            <strong>${escapeHtml(entry.title)}</strong>
            <small>Added ${escapeHtml(formatMediaDate(entry.createdAt))} by ${escapeHtml(entry.authorUsername)}</small>
          </span>
          <span class="media-entry-caret">${expanded ? "Close" : "Read"}</span>
        </button>
        <div class="media-entry-full" ${expanded ? "" : "hidden"}>
          ${canModify ? `
            <div class="media-entry-actions">
              <button type="button" aria-label="Edit media entry" title="Edit" data-media-edit="${entry.id}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5V20h2.5L17.8 8.7l-2.5-2.5L4 17.5Zm13.2-12.7 2 2 .9-.9a1.4 1.4 0 0 0 0-2l-.1-.1a1.4 1.4 0 0 0-2 0l-.8 1Z"/></svg>
              </button>
              <button type="button" aria-label="Delete media entry" title="Delete" data-media-delete="${entry.id}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5V3.5h8V5h4v2H4V5h4Zm-1 4h10l-.7 11H7.7L7 9Zm3 2v7h1.5v-7H10Zm2.5 0v7H14v-7h-1.5Z"/></svg>
              </button>
            </div>
          ` : ""}
          <div class="media-entry-body">${mediaBodyMarkup(entry.body)}</div>
        </div>
      </article>`;
  }).join("");
}

async function markMediaEntrySeen(id) {
  if (!state.unreadMediaEntryIds?.includes(id)) return;
  state.unreadMediaEntryIds = state.unreadMediaEntryIds.filter((entryId) => entryId !== id);
  updateMediaAlertBadges();
  try {
    const response = await fetch(`/api/media/${id}/seen`, { method: "POST" });
    if (response.ok) {
      const result = await response.json();
      state.mediaEntries = result.entries || state.mediaEntries;
      state.unreadMediaEntryIds = result.unreadEntryIds || [];
      updateMediaAlertBadges();
    }
  } catch {
    // Media read receipts are cosmetic; the entry can still be read if saving fails.
  }
}

function sortRacers(racers, sort) {
  return [...racers].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    return b[sort] - a[sort] || a.name.localeCompare(b.name);
  });
}

function statTilesMarkup(racer) {
  const stats = [
    ["PAC", racer.pace, "Pace"],
    ["CTL", racer.control, "Control"],
    ["OVT", racer.overtaking, "Overtaking"],
    ["STA", racer.stamina, "Stamina"],
    ["TEC", racer.technical, "Technical"],
    ["WRD", racer.weird, "Weird"],
    ["POT", racer.potential, "Potential"],
  ];
  return `
    <div class="ratings" aria-label="${escapeAttribute(racer.name)} ratings">
      ${stats.map(([abbreviation, value, label]) => `
        <span class="rating ${abbreviation === "POT" ? "potential" : ""} ${abbreviation === "WRD" && racer.speed_mark ? "marked" : ""} ${racer.cappedStats?.includes(label.toLocaleLowerCase()) ? "capped" : ""}" title="${label}${racer.cappedStats?.includes(label.toLocaleLowerCase()) ? " (discovered cap)" : ""}${abbreviation === "WRD" && racer.speed_mark ? " / Mark of The Speed God" : ""}">
          <span class="rating-label">${abbreviation}</span>
          <strong class="rating-value">${value}</strong>
        </span>
      `).join("")}
    </div>`;
}

function draftRacerMarkup(racer, disabled, rookie = false) {
  return `
    <article class="draft-racer">
      ${racerIdentityMarkup(racer)}
      ${statTilesMarkup(racer)}
      <button class="primary-button" data-${rookie ? "rookie-" : ""}draft-racer="${racer.id}" ${disabled ? "disabled" : ""}>Draft racer</button>
      ${disabled ? `<p class="draft-card-note">Waiting for your team's turn.</p>` : ""}
    </article>`;
}

function renderDraftInitiation() {
  const initiation = state.draft.initiation || {
    voteCount: 0,
    requiredVotes: teams.length,
    votes: [],
    allTeamsAssigned: false,
    retentionRequired: false,
    retentionOptions: {},
  };
  const voted = initiation.votes?.some((vote) => vote.team_id === managedTeamId());
  const retention = initiation.retentionOptions?.[managedTeamId()] || {
    veterans: [],
    rookies: [],
  };
  if (elements.draftRetentionFields) {
    elements.draftRetentionFields.hidden = !initiation.retentionRequired;
  }
  if (elements.draftRetainVeteran && elements.draftRetainRookie) {
    const selected = retention.selected || {};
    elements.draftRetainVeteran.innerHTML = [
      `<option value="">Select veteran</option>`,
      ...retention.veterans.map((racer) => (
        `<option value="${racer.id}" ${selected.veteranRacerId === racer.id ? "selected" : ""}>${escapeHtml(racer.name)}</option>`
      )),
    ].join("");
    elements.draftRetainRookie.innerHTML = [
      `<option value="">Select rookie</option>`,
      ...retention.rookies.map((racer) => (
        `<option value="${racer.id}" ${selected.rookieRacerId === racer.id ? "selected" : ""}>${escapeHtml(racer.name)}</option>`
      )),
    ].join("");
    elements.draftRetainVeteran.disabled = !initiation.allTeamsAssigned || voted;
    elements.draftRetainRookie.disabled = !initiation.allTeamsAssigned || voted;
  }
  const retentionReady = !initiation.retentionRequired
    || (elements.draftRetainVeteran?.value && elements.draftRetainRookie?.value);
  elements.draftInitiationProgress.textContent = initiation.allTeamsAssigned
    ? `${initiation.voteCount} of ${initiation.requiredVotes} teams have voted to initiate the season and begin the opening draft.`
    : "Waiting for all teams to be assigned before the season can be initiated.";
  elements.startDraft.disabled = !initiation.allTeamsAssigned || voted || !retentionReady;
  elements.draftInitiationCode.disabled = !initiation.allTeamsAssigned || voted;
  elements.startDraft.textContent = voted
    ? "Your team has voted"
    : "Vote to initiate the season and begin the opening draft";
  updateDraftVoteAlertBadges();
}

function renderDraft() {
  const draft = state.draft;
  const hasDraft = draft.status !== "not_started";
  const draftComplete = draft.status === "complete";
  const season = state.raceCenter?.season || 1;
  elements.draftEmpty.hidden = hasDraft;
  elements.draftRoom.hidden = !hasDraft;
  if (!hasDraft) {
    renderDraftInitiation();
    return;
  }

  elements.draftStatus.hidden = draftComplete;
  elements.draftPoolPanel.hidden = draftComplete;
  elements.draftLayout.classList.toggle("history-only", draftComplete);
  elements.draftHistoryTitle.textContent = draftComplete
    ? `Season ${season} Opening Draft Picks`
    : "Pick history";

  const currentTeam = teams.find((team) => team.id === draft.currentTeamId);
  elements.draftTeam.textContent = draftComplete
    ? "Draft complete"
    : currentTeam
      ? `${currentTeam.short} / ${currentTeam.name}`
      : "Awaiting season vote";
  elements.draftPick.textContent = draftComplete
    ? `${draft.picks.length} selections`
    : `Pick ${draft.currentPick} / Round ${draft.currentRound}`;
  elements.draftAvailable.textContent = String(draft.pool.length);
  const managerOnClock = draft.currentTeamId === managedTeamId();
  elements.draftMessage.classList.toggle("draft-turn-message", !draftComplete);
  elements.draftMessage.classList.toggle("on-clock", managerOnClock && !draftComplete);
  elements.draftMessage.textContent = draftComplete
    ? "The opening draft is complete."
    : !currentTeam
      ? "Vote to begin the season and start the opening draft."
      : managerOnClock
      ? "You are on the clock!"
      : `Waiting for ${currentTeam.short} / ${currentTeam.name}.`;

  const sort = elements.draftSort.value;
  const pool = [...draft.pool].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    return b[sort] - a[sort] || a.name.localeCompare(b.name);
  });
  elements.draftPool.innerHTML = draftComplete
    ? `<div class="draft-complete">The opening draft is complete. New rosters are now active in every garage.</div>`
    : pool.map((racer) => draftRacerMarkup(racer, !managerOnClock)).join("");

  elements.draftHistory.innerHTML = draft.picks.length
    ? [...draft.picks].reverse().map((pick) => {
      const team = teams.find((item) => item.id === pick.team_id);
      return `
        <div class="draft-pick-row">
          <span>#${pick.pick_number}</span>
          <span>${team?.short || pick.team_id}</span>
          <strong>${escapeHtml(pick.racer_name)}</strong>
        </div>`;
    }).join("")
    : `<p class="muted">No selections yet. The first team is on the clock.</p>`;
  renderNewsTicker();
}

function formatDraftDeadline(deadline) {
  if (!deadline) return "";
  const remaining = Math.max(0, new Date(deadline).getTime() - currentTimeMs());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} remaining`;
}

function renderRookieReleaseSelectors() {
  const awaiting = state.rookieDraft.teamsAwaitingRelease || [];
  const team = awaiting.includes(managedTeamId()) ? managedTeam() : null;
  const currentRookieSource = `rookie-${state.rookieDraft.season || state.raceCenter?.season || 1}`;
  const releaseOptions = (team?.drivers || []).filter((racer) => racer.source !== currentRookieSource);
  const selectedRacerId = elements.rookieReleaseRacer.value;
  elements.rookieReleaseTeam.textContent = team
    ? `${team.name} must release one non-rookie racer to free agency.`
    : `Waiting on ${awaiting.map((teamId) => teams.find((item) => item.id === teamId)?.short || teamId).join(", ")}.`;
  elements.rookieReleaseRacer.innerHTML = releaseOptions.map((racer) => (
    `<option value="${racer.id}">${escapeHtml(racer.name)}</option>`
  )).join("");
  if (releaseOptions.some((racer) => racer.id === selectedRacerId)) {
    elements.rookieReleaseRacer.value = selectedRacerId;
  }
  elements.submitRookieRelease.disabled = !team || !releaseOptions.length;
}

function renderRookieDraftInitiation() {
  const initiation = state.rookieDraft.initiation || {
    voteCount: 0,
    requiredVotes: teams.length,
    votes: [],
    allTeamsAssigned: false,
  };
  const voted = initiation.votes?.some((vote) => vote.team_id === managedTeamId());
  elements.rookieDraftInitiationProgress.textContent = initiation.allTeamsAssigned
    ? `${initiation.voteCount} of ${initiation.requiredVotes} teams have voted to begin the rookie draft.`
    : "Waiting for all teams to be assigned before the rookie draft can begin.";
  elements.startRookieDraft.disabled = !initiation.allTeamsAssigned || voted;
  elements.rookieDraftInitiationCode.disabled = !initiation.allTeamsAssigned || voted;
  elements.startRookieDraft.textContent = voted
    ? "Your team has voted"
    : "Vote to begin the rookie draft";
}

function renderRookieDraft() {
  const draft = state.rookieDraft;
  const draftComplete = draft.status === "complete";
  const draftVoting = draft.status === "voting";
  const season = state.raceCenter?.season || 1;
  const draftView = elements.rookieDraftRoom?.parentElement;
  if (draftView) {
    const activeRookieDraft = ["voting", "active", "releases"].includes(draft.status);
    const completedRookieDraft = draft.status === "complete";
    const reference = elements.draftEmpty.hidden ? elements.draftRoom : elements.draftEmpty;
    if (activeRookieDraft && reference && elements.rookieDraftRoom !== reference.previousElementSibling) {
      draftView.insertBefore(elements.rookieDraftRoom, reference);
    } else if (completedRookieDraft && elements.draftRoom && elements.rookieDraftRoom !== elements.draftRoom.previousElementSibling) {
      draftView.insertBefore(elements.rookieDraftRoom, elements.draftRoom);
    } else if (!activeRookieDraft && !completedRookieDraft && elements.draftRoom.nextElementSibling !== elements.rookieDraftRoom) {
      draftView.insertBefore(elements.rookieDraftRoom, elements.draftRoom.nextElementSibling);
    }
  }
  elements.rookieDraftRoom.hidden = draft.status === "not_started";
  if (draft.status === "not_started") return;
  elements.rookieDraftHeading.hidden = draftComplete;
  elements.rookieDraftInitiation.hidden = !draftVoting;
  if (draftVoting) renderRookieDraftInitiation();
  elements.rookieDraftStatus.hidden = draftComplete || draftVoting;
  elements.rookieDraftPoolPanel.hidden = draftComplete;
  elements.rookieDraftLayout.classList.toggle("history-only", draftComplete);
  elements.rookieDraftHistoryTitle.textContent = draftComplete
    ? `Mid-Season ${season} Rookie Draft Picks`
    : "Rookie picks";
  const currentTeam = teams.find((team) => team.id === draft.currentTeamId);
  const managerOnClock = draft.currentTeamId === managedTeamId();
  elements.rookieDraftTeam.textContent = draft.status === "active"
    ? currentTeam
      ? `${currentTeam.short} / ${currentTeam.name}`
      : "Awaiting draft order"
    : draft.status === "releases"
      ? "All selections complete"
      : "Rookie draft complete";
  elements.rookieDraftPick.textContent = draft.status === "active"
    ? `Pick ${draft.currentPick} / Round ${draft.currentRound}`
    : `${draft.picks.length} selections`;
  elements.rookieDraftAvailable.textContent = String(draft.pool.length);
  elements.rookieDraftClock.textContent = draft.status === "active"
    ? formatDraftDeadline(draft.pickDeadline)
    : draft.status === "releases"
      ? "Roster releases required"
      : draft.status === "voting"
        ? "Awaiting votes"
      : "Complete";
  elements.rookieDraftMessage.classList.toggle("draft-turn-message", !draftComplete);
  elements.rookieDraftMessage.classList.toggle("on-clock", managerOnClock && draft.status === "active");
  elements.rookieDraftMessage.textContent = draft.status === "active"
    ? !currentTeam
      ? "Waiting for the rookie draft order."
      : managerOnClock
      ? "You are on the clock!"
      : `Waiting for ${currentTeam.short} / ${currentTeam.name}.`
    : draft.status === "releases"
      ? state.rookieDraft.teamsAwaitingRelease?.includes(managedTeamId())
        ? "Your team must release one racer."
        : "Waiting for other teams to complete roster releases."
    : draft.status === "voting"
      ? "Review the rookie class while the league votes to begin the draft."
      : "The rookie draft is complete.";
  const pool = sortRacers(draft.pool, elements.rookieDraftSort.value);
  elements.rookieDraftPool.innerHTML = draftComplete
    ? `<div class="draft-complete">The rookie draft is complete. Unselected rookies are now free agents.</div>`
    : pool.map((racer) => draftRacerMarkup(racer, draft.status !== "active" || !managerOnClock, true)).join("");
  elements.rookieDraftHistory.innerHTML = draft.picks.length
    ? [...draft.picks].reverse().map((pick) => {
      const team = teams.find((item) => item.id === pick.team_id);
      return `<div class="draft-pick-row">
        <span>#${pick.pick_number}</span>
        <span>${team?.short || pick.team_id}</span>
        <strong>${escapeHtml(pick.racer_name)}${pick.automatic ? " [AUTO]" : ""}</strong>
      </div>`;
    }).join("")
    : draftVoting
      ? `<p class="muted">The rookie class is ready. The draft begins once all six teams vote with the league code.</p>`
      : `<p class="muted">Race 10 is complete. The lowest-ranked team is on the clock.</p>`;
  elements.rookieReleasePanel.hidden = draft.status !== "releases";
  if (draft.status === "releases") renderRookieReleaseSelectors();
  updateDraftVoteAlertBadges();
  renderNewsTicker();
}

function optionMarkup(items, selectedId = null) {
  return items.map((item) => `
    <option value="${item.id}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}</option>
  `).join("");
}

function renderMoveSelectors() {
  const actingTeamId = managedTeamId();
  const actingTeam = teams.find((team) => team.id === actingTeamId);
  const currentTradeTeamId = elements.tradeTeam.value;
  const otherTeams = teams.filter((team) => team.id !== actingTeamId);
  const receivingTeam = otherTeams.find((team) => team.id === currentTradeTeamId) || otherTeams[0];

  elements.movesTeam.textContent = managedTeamLabel();
  elements.tradeTeam.innerHTML = otherTeams.map((team) => `
    <option value="${team.id}" ${team.id === receivingTeam.id ? "selected" : ""}>${team.short} / ${team.name}</option>
  `).join("");
  const currentRookieSource = `rookie-${state.raceCenter?.season || 1}`;
  const releasableDrivers = actingTeam.drivers.filter((racer) => racer.source !== currentRookieSource);
  elements.tradeOffered.innerHTML = optionMarkup(actingTeam.drivers);
  elements.tradeRequested.innerHTML = optionMarkup(receivingTeam.drivers);
  elements.releaseRacer.innerHTML = releasableDrivers.length
    ? optionMarkup(releasableDrivers)
    : `<option value="">No eligible release candidates</option>`;
  elements.freeAgent.innerHTML = state.transactions.freeAgents.length
    ? optionMarkup(state.transactions.freeAgents)
    : `<option value="">No free agents available</option>`;
  elements.proposeTrade.disabled = !actingTeam.drivers.length || !receivingTeam.drivers.length;
  elements.signFreeAgent.disabled = !state.transactions.freeAgents.length || !releasableDrivers.length;
}

function renderTransactions() {
  renderMoveSelectors();
  updateTradeAlertBadges();
  const actingTeamId = managedTeamId();
  const visibleOffers = state.transactions.offers.filter((offer) => (
    offer.offering_team_id === actingTeamId || offer.receiving_team_id === actingTeamId
  ));

  elements.tradeOffers.innerHTML = visibleOffers.length
    ? visibleOffers.map((offer) => {
      const offering = teams.find((team) => team.id === offer.offering_team_id);
      const receiving = teams.find((team) => team.id === offer.receiving_team_id);
      const canRespond = offer.status === "pending" && offer.receiving_team_id === actingTeamId;
      return `
        <article class="trade-offer">
          <strong>${offering.short} offers ${escapeHtml(offer.offered_racer_name)}</strong>
          <p>To ${receiving.name} for ${escapeHtml(offer.requested_racer_name)}.</p>
          ${canRespond ? `
            <div class="trade-actions">
              <button data-trade-id="${offer.id}" data-action="accept">Accept</button>
              <button data-trade-id="${offer.id}" data-action="reject">Reject</button>
            </div>
          ` : `<span class="offer-status">${offer.status}</span>`}
        </article>`;
    }).join("")
    : `<p class="muted">No trade offers involve this team.</p>`;

  elements.transactionHistory.innerHTML = state.transactions.history.length
    ? state.transactions.history.map((transaction) => {
      const team = teams.find((item) => item.id === transaction.team_id);
      const text = transaction.type === "trade"
        ? `${team.short} acquired ${transaction.acquired_racer_name} in a trade.`
        : `${team.short} signed ${transaction.acquired_racer_name} and released ${transaction.moved_racer_name}.`;
      return `<article class="transaction-row"><strong>${escapeHtml(text)}</strong></article>`;
    }).join("")
    : `<p class="muted">No completed transactions yet.</p>`;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderDevelopment() {
  const actingTeamId = managedTeamId();
  const actingTeam = teams.find((team) => team.id === actingTeamId);
  const teamChoice = state.development.choices.find((choice) => choice.team_id === actingTeamId);
  const carChoice = state.development.carChoices.find(
    (choice) => choice.team_id === actingTeamId,
  );
  const eligibleIds = new Set(state.development.eligibleRacerIdsByTeam?.[actingTeamId] || []);
  const eligibleRacers = actingTeam.drivers.filter((driver) => eligibleIds.has(driver.id));

  elements.developmentTeam.textContent = managedTeamLabel();

  elements.upgradeOptions.innerHTML = state.development.options.map((stat, optionIndex) => {
    const applied = Boolean(teamChoice?.applied_at);
    const isSelected = teamChoice?.option_index === optionIndex;
    const unavailable = applied || !eligibleRacers.length;
    const buttonText = applied
      ? "Training applied"
      : isSelected
        ? "Update lock-in"
        : eligibleRacers.length
        ? `Choose ${titleCase(stat)}`
        : "No eligible racers";
    return `
      <article class="upgrade-card ${unavailable ? "unavailable" : ""} ${isSelected && !applied ? "selected" : ""}">
        <span class="upgrade-number">League option ${optionIndex + 1}</span>
        <h3>${titleCase(stat)} Training</h3>
        <p>Choose a racer who drove this week. The selection locks in now and applies Sunday at 12:01 AM Eastern.</p>
        <select data-upgrade-racer="${optionIndex}" aria-label="${titleCase(stat)} training racer" ${unavailable ? "disabled" : ""}>
          ${eligibleRacers.length
            ? eligibleRacers.map((racer) => `
              <option value="${racer.id}" ${isSelected && teamChoice.racer_id === racer.id ? "selected" : ""}>${escapeHtml(racer.name)}</option>
            `).join("")
            : `<option>No racers have driven this week</option>`}
        </select>
        <button class="primary-button" data-upgrade-option="${optionIndex}" ${unavailable ? "disabled" : ""}>
          ${buttonText}
        </button>
      </article>`;
  }).join("");

  elements.carUpgradeOptions.innerHTML = state.development.carOptions.map(
    (stat, optionIndex) => {
      const applied = Boolean(carChoice?.applied_at);
      const isSelected = carChoice?.option_index === optionIndex;
      const unavailable = applied;
      return `
        <article class="upgrade-card ${unavailable ? "unavailable" : ""} ${isSelected && !applied ? "selected" : ""}">
          <span class="upgrade-number">League option ${optionIndex + 1}</span>
          <h3>${titleCase(stat)} Upgrade</h3>
          <p>Lock in +1 ${stat} for one of this team's cars. The upgrade applies Sunday at 12:01 AM Eastern.</p>
          <select data-upgrade-car="${optionIndex}" aria-label="${titleCase(stat)} car" ${unavailable ? "disabled" : ""}>
            ${state.carNames[actingTeamId].map((name, carIndex) => `
              <option value="${carIndex}" ${isSelected && carChoice.car_index === carIndex ? "selected" : ""}>${actingTeam.short} ${escapeHtml(name)}</option>
            `).join("")}
          </select>
          <button class="primary-button" data-car-upgrade-option="${optionIndex}" ${unavailable ? "disabled" : ""}>
            ${applied ? "Upgrade applied" : isSelected ? "Update lock-in" : `Choose ${titleCase(stat)}`}
          </button>
        </article>`;
    },
  ).join("");

  const trainingHistory = state.development.choices.map((choice) => {
      const team = teams.find((item) => item.id === choice.team_id);
      const applied = Boolean(choice.applied_at);
      const description = !applied
        ? `${choice.racer_name} is locked in for ${titleCase(choice.stat)} Training.`
        : choice.result === "improved"
        ? `${choice.racer_name} gained +1 ${titleCase(choice.stat)}.`
        : `${choice.racer_name} discovered their ${titleCase(choice.stat)} cap.`;
      return `
        <article class="development-record">
          <span class="team-code">${team.short}</span>
          <p>${escapeHtml(description)}</p>
          <span class="development-result ${applied ? choice.result : "pending"}">${applied ? choice.result : "pending"}</span>
        </article>`;
    });
  const carHistory = state.development.carChoices.map((choice) => {
    const team = teams.find((item) => item.id === choice.team_id);
    const carName = state.carNames[choice.team_id]?.[choice.car_index] || `Car ${choice.car_index + 1}`;
    const applied = Boolean(choice.applied_at);
    return `
      <article class="development-record">
        <span class="team-code">${team.short}</span>
        <p>${escapeHtml(applied
          ? `${team.short} ${carName} gained +1 ${titleCase(choice.stat)}.`
          : `${team.short} ${carName} is locked in for a ${titleCase(choice.stat)} Upgrade.`)}</p>
        <span class="development-result ${applied ? "improved" : "pending"}">${applied ? "upgraded" : "pending"}</span>
      </article>`;
  });
  elements.developmentHistory.innerHTML = trainingHistory.length || carHistory.length
    ? [...trainingHistory, ...carHistory].join("")
    : `<p class="muted">No team has selected a weekly upgrade yet.</p>`;
}

function selectTeam(teamId) {
  state.selectedTeamId = teamId;
  state.relayPlanEditing = false;
  applyTeamTheme(teamId);
  elements.saveMessage.textContent = "";
  renderTeamPicker();
  renderTeamProfile();
  renderLineupEditor();
  renderGarageCars();
}

async function loadLeagueState() {
  const response = await fetch("/api/league-state");
  if (!response.ok) throw new Error("Could not load league state.");
  const saved = await response.json();
  for (const team of teams) {
    if (saved.rosters?.[team.id]) team.drivers = saved.rosters[team.id];
  }
  state.brands = Object.fromEntries(
    (saved.brands || []).map((brand) => [brand.team_id, brand]),
  );
  state.brandColors = saved.brandColors || [];
  for (const team of teams) {
    const brand = state.brands[team.id];
    if (!brand) continue;
    team.name = brand.name;
    team.short = brand.abbreviation;
    team.color = brand.color;
    team.accent = lightTeamColor(brand.color);
  }
  state.lineups = { ...defaultLineups, ...saved.lineups };
  state.carNames = { ...defaultCarNamesByTeam, ...saved.carNames };
  state.cars = saved.cars || {};
  applyTeamTheme();
}

async function loadDraft() {
  const response = await fetch("/api/draft");
  if (!response.ok) throw new Error("Could not load draft state.");
  state.draft = await response.json();
  syncUnreadDraftVoteAlerts(state.draft);
  refreshDraftVoteAlerts();
}

async function loadRookieDraft() {
  const response = await fetch("/api/rookie-draft");
  if (!response.ok) throw new Error("Could not load the rookie draft.");
  state.rookieDraft = await response.json();
  syncUnreadDraftVoteAlerts(state.rookieDraft);
  refreshDraftVoteAlerts();
}

async function loadInitiationMartyr() {
  const response = await fetch("/api/initiation-martyr");
  if (!response.ok) throw new Error("Could not load the Initiation Martyr vote.");
  state.martyr = await response.json();
}

function renderInitiationMartyrVote() {
  if (state.martyr.status !== "voting") {
    if (elements.martyrVoteDialog.open) elements.martyrVoteDialog.close();
    return;
  }
  const votedTeamIds = new Set(state.martyr.votes.map((vote) => vote.team_id));
  const unvotedTeams = teams.filter((team) => !votedTeamIds.has(team.id));
  const canVote = unvotedTeams.some((team) => team.id === managedTeamId());
  elements.martyrTeam.textContent = managedTeamLabel();
  elements.martyrCandidate.innerHTML = state.martyr.candidates.map((racer) => (
    `<option value="${racer.id}">${escapeHtml(racer.name)} (${escapeHtml(racer.pronouns)})</option>`
  )).join("");
  elements.martyrVoteProgress.innerHTML = teams.map((team) => (
    `<span class="${votedTeamIds.has(team.id) ? "voted" : ""}">${escapeHtml(team.short)} ${votedTeamIds.has(team.id) ? "voted" : "awaiting"}</span>`
  )).join("");
  elements.martyrVoteMessage.textContent = `${state.martyr.votes.length} of ${teams.length} votes cast.`;
  elements.submitMartyrVote.disabled = !canVote || !state.martyr.candidates.length;
  if (!elements.martyrVoteDialog.open) elements.martyrVoteDialog.showModal();
}

function showInitiationMartyrResult(martyr) {
  const possessive = pronounForms(martyr).possessive;
  const capitalizedPossessive = possessive[0].toUpperCase() + possessive.slice(1);
  elements.martyrResultMessage.textContent = `Huzzah! ${martyr.name} has been chosen as this season's Initiation Martyr! ${capitalizedPossessive} days are numbered...\n`;
  if (!elements.martyrResultDialog.open) elements.martyrResultDialog.showModal();
}

async function loadTransactions() {
  const response = await fetch("/api/transactions");
  if (!response.ok) throw new Error("Could not load roster transactions.");
  state.transactions = await response.json();
  updateTradeAlertBadges();
}

function selectedMovesTeamId() {
  return managedTeamId();
}

function pendingIncomingTradeOffers() {
  const actingTeamId = selectedMovesTeamId();
  return state.transactions.offers.filter((offer) => (
    offer.status === "pending" && offer.receiving_team_id === actingTeamId
  ));
}

function resolvedSentTradeOffers() {
  const actingTeamId = selectedMovesTeamId();
  return state.transactions.offers.filter((offer) => (
    offer.status !== "pending" && offer.offering_team_id === actingTeamId
  ));
}

function hasUnreadTradeOffers() {
  return Boolean(state.transactions.unreadTradeAlertIds?.length);
}

async function markPendingTradeOffersSeen() {
  if (!hasUnreadTradeOffers()) return;
  state.transactions.unreadTradeAlertIds = [];
  updateTradeAlertBadges();
  try {
    const response = await fetch("/api/transactions/alerts/seen", { method: "POST" });
    if (response.ok) {
      state.transactions = await response.json();
      updateTradeAlertBadges();
    }
  } catch {
    // Trade alerts are cosmetic; failing to save the read receipt should not block navigation.
  }
}

function updateTradeAlertBadges() {
  const hasUnread = hasUnreadTradeOffers();
  document.querySelector('[data-section="office"]')?.classList.toggle("has-alert", hasUnread || hasOfficeDraftVoteAlert());
  document.querySelector('[data-subview="moves"]')?.classList.toggle("has-alert", hasUnread);
  if (elements.tradeAlertMessage) {
    const incoming = pendingIncomingTradeOffers();
    const unread = new Set(state.transactions.unreadTradeAlertIds || []);
    const unreadResolved = resolvedSentTradeOffers().some((offer) => unread.has(
      `resolved:${selectedMovesTeamId()}:${offer.id}:${offer.status}:${offer.resolved_at || ""}`,
    ));
    elements.tradeAlertMessage.hidden = !incoming.length && !unreadResolved;
    elements.tradeAlertMessage.textContent = incoming.length
      ? "You have a pending trade offer!"
      : "A trade offer you sent has been resolved.";
  }
}

function currentDraftVoteAlertKeys() {
  const keys = [];
  if (state.draft.status === "not_started" && state.draft.initiation?.allTeamsAssigned) {
    keys.push(`opening:${state.draft.initiation.season || state.raceCenter?.season || 1}`);
  }
  if (state.rookieDraft.status === "voting") {
    keys.push(`rookie:${state.rookieDraft.season || state.raceCenter?.season || 1}`);
  }
  return keys;
}

function syncUnreadDraftVoteAlerts(...sources) {
  const merged = new Set(state.unreadDraftVoteAlertIds || []);
  for (const source of sources) {
    for (const key of source?.unreadDraftVoteAlertIds || []) merged.add(key);
  }
  state.unreadDraftVoteAlertIds = [...merged];
}

function refreshDraftVoteAlerts() {
  const activeKeys = currentDraftVoteAlertKeys();
  state.draftVoteAlertKeys = activeKeys;
  const activeSet = new Set(activeKeys);
  state.noticedDraftVoteAlertKeys = state.noticedDraftVoteAlertKeys.filter((key) => activeSet.has(key));
  state.unreadDraftVoteAlertIds = (state.unreadDraftVoteAlertIds || []).filter((key) => activeSet.has(key));
  state.clearedDraftVoteAlertKeys = activeKeys.filter((key) => !state.unreadDraftVoteAlertIds.includes(key));
  updateDraftVoteAlertBadges();
}

function unhandledDraftVoteAlertKeys() {
  return (state.draftVoteAlertKeys || []).filter((key) => !state.clearedDraftVoteAlertKeys.includes(key));
}

function hasOfficeDraftVoteAlert() {
  return unhandledDraftVoteAlertKeys().some((key) => !state.noticedDraftVoteAlertKeys.includes(key));
}

function hasDraftSubnavVoteAlert() {
  return unhandledDraftVoteAlertKeys().some((key) => state.noticedDraftVoteAlertKeys.includes(key));
}

function updateDraftVoteAlertBadges() {
  const officeHasDraftAlert = hasOfficeDraftVoteAlert();
  const draftSubnavHasAlert = hasDraftSubnavVoteAlert();
  const officeButton = document.querySelector('[data-section="office"]');
  officeButton?.classList.toggle("has-alert", hasUnreadTradeOffers() || officeHasDraftAlert);
  document.querySelector('[data-subview="draft"]')?.classList.toggle("has-alert", draftSubnavHasAlert);
}

function markDraftVoteAlertOfficeSeen() {
  const keys = unhandledDraftVoteAlertKeys();
  state.noticedDraftVoteAlertKeys = [
    ...new Set([...state.noticedDraftVoteAlertKeys, ...keys]),
  ];
  updateDraftVoteAlertBadges();
}

function clearDraftVoteAlert() {
  const keys = unhandledDraftVoteAlertKeys();
  state.noticedDraftVoteAlertKeys = [
    ...new Set([...state.noticedDraftVoteAlertKeys, ...keys]),
  ];
  state.clearedDraftVoteAlertKeys = [
    ...new Set([...state.clearedDraftVoteAlertKeys, ...keys]),
  ];
  state.unreadDraftVoteAlertIds = (state.unreadDraftVoteAlertIds || []).filter((key) => !keys.includes(key));
  updateDraftVoteAlertBadges();
  if (keys.length) {
    fetch("/api/draft/alerts/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertIds: keys }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (!result) return;
        state.unreadDraftVoteAlertIds = result.unreadDraftVoteAlertIds || [];
        refreshDraftVoteAlerts();
      })
      .catch(() => {
        // Draft vote badges are cosmetic; failing to save read state should not block navigation.
      });
  }
}

async function loadDevelopment() {
  const response = await fetch("/api/development");
  if (!response.ok) throw new Error("Could not load weekly development.");
  state.development = await response.json();
}

async function loadRaceCenter() {
  const response = await fetch("/api/races");
  if (!response.ok) throw new Error("Could not load race archive.");
  state.raceCenter = await response.json();
}

async function loadRacerDirectory() {
  const response = await fetch("/api/racers");
  if (!response.ok) throw new Error("Could not load racer directory.");
  state.racerDirectory = await response.json();
}

async function loadInMemoriam() {
  const response = await fetch("/api/in-memoriam");
  if (!response.ok) throw new Error("Could not load In Memoriam.");
  state.inMemoriam = await response.json();
}

async function loadMediaEntries() {
  const previousUnread = new Set(state.unreadMediaEntryIds || []);
  const response = await fetch("/api/media");
  if (!response.ok) throw new Error("Could not load league media.");
  const result = await response.json();
  state.mediaEntries = result.entries || [];
  state.mediaAuthorProfiles = result.authorProfiles || [];
  state.unreadMediaEntryIds = result.unreadEntryIds || [];
  if (state.unreadMediaEntryIds.some((id) => !previousUnread.has(id))) {
    state.mediaMenuNoticed = false;
  }
  updateMediaAlertBadges();
}

async function refreshLeagueAndTransactions() {
  await Promise.all([loadLeagueState(), loadTransactions(), loadRacerDirectory()]);
  renderInitialStandings();
  renderTeamProfile();
  renderLineupEditor();
  renderLeague();
  renderTransactions();
  renderRacerDirectories();
}

async function refreshAfterStewardsAction(center = null) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  state.activeLeagueRace = null;
  if (center) state.raceCenter = center;
  await Promise.all([
    loadLeagueState(),
    loadDraft(),
    loadRookieDraft(),
    loadInitiationMartyr(),
    loadTransactions(),
    loadDevelopment(),
    loadRaceCenter(),
    loadRacerDirectory(),
    loadInMemoriam(),
  ]);
  renderInitialStandings();
  renderTeamProfile();
  renderLineupEditor();
  renderGarageCars();
  renderLeague();
  renderDraft();
  renderRookieDraft();
  renderTransactions();
  renderDevelopment();
  renderBrand();
  renderRaceArchive();
  renderRacerDirectories();
  renderInMemoriam();
  renderRaceControls();
  if (state.raceCenter.raceActive && state.raceCenter.activeRaceId) {
    const response = await fetch(`/api/races/${state.raceCenter.activeRaceId}`);
    const activeRace = await response.json();
    if (response.ok) {
      state.activeLeagueRace = activeRace;
      elements.speed.value = "1";
      playRace(
        activeRace,
        false,
        raceElapsedSinceStart(activeRace.startAt),
      );
      return;
    }
  }
  await renderIdleRaceFeed();
}

async function resumeActiveRaceView() {
  if (state.activeSection !== "race" || state.activeViewBySection.race !== "race") return;
  if (!state.raceCenter.raceActive || !state.raceCenter.activeRaceId) return;
  if (state.running && state.timer && state.race?.id === state.raceCenter.activeRaceId) return;

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;

  let activeRace = state.activeLeagueRace;
  if (!activeRace || activeRace.id !== state.raceCenter.activeRaceId) {
    const response = await fetch(`/api/races/${state.raceCenter.activeRaceId}`);
    const result = await response.json();
    if (!response.ok) return;
    activeRace = result;
    state.activeLeagueRace = activeRace;
  }

  elements.speed.value = "1";
  playRace(
    activeRace,
    false,
    raceElapsedSinceStart(activeRace.startAt),
  );
}

function activateSection(sectionName, requestedView = null) {
  const tabs = tabsForSection(sectionName);
  if (!tabs.length) return;
  if (elements.rulesPage) elements.rulesPage.hidden = true;
  if (elements.mediaPage) elements.mediaPage.hidden = true;
  const viewName = tabs.some((tab) => tab.view === requestedView)
    ? requestedView
    : tabs.some((tab) => tab.view === state.activeViewBySection[sectionName])
      ? state.activeViewBySection[sectionName]
      : tabs[0].view;
  state.activeSection = sectionName;
  state.activeViewBySection[sectionName] = viewName;

  document.querySelectorAll(".nav-link").forEach(
    (item) => item.classList.toggle("active", item.dataset.section === sectionName),
  );
  const activeTab = document.querySelector(`.nav-link[data-section="${sectionName}"]`);
  const subnavShell = document.querySelector(".subnav-shell");
  if (activeTab && subnavShell) {
    const tabRect = activeTab.getBoundingClientRect();
    const shellRect = subnavShell.getBoundingClientRect();
    subnavShell.style.setProperty("--active-tab-left", `${tabRect.left - shellRect.left}px`);
    subnavShell.style.setProperty("--active-tab-width", `${tabRect.width}px`);
  }
  elements.subnav.innerHTML = tabs.map((tab) => `
    <button class="subnav-link ${tab.view === viewName ? "active" : ""} ${tab.view === "moves" && hasUnreadTradeOffers() ? "has-alert" : ""} ${tab.view === "draft" && hasDraftSubnavVoteAlert() ? "has-alert" : ""}" data-subview="${tab.view}">
      ${tab.label}
    </button>
  `).join("");
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelector(`#${viewName}-view`).classList.add("active");
  elements.raceStatusBanner.hidden = !(
    (sectionName === "race" && viewName === "race")
    || (sectionName === "garage" && viewName === "relay")
  );
  if (sectionName === "office" && viewName === "moves") {
    markPendingTradeOffersSeen();
  }
  writeNavigationState("section");
  renderNewsTicker();
  updateTradeAlertBadges();
  updateDraftVoteAlertBadges();
  if (sectionName === "race" && viewName === "race") {
    void resumeActiveRaceView();
  }
}

function closeAppMenu() {
  elements.appMenu.hidden = true;
  elements.appMenuButton.setAttribute("aria-expanded", "false");
}

function toggleAppMenu() {
  const isOpening = elements.appMenu.hidden;
  elements.appMenu.hidden = !isOpening;
  elements.appMenuButton.setAttribute("aria-expanded", String(isOpening));
  if (isOpening && hasUnreadMediaEntries()) {
    state.mediaMenuNoticed = true;
    updateMediaAlertBadges();
  }
}

function showRulesPage() {
  closeAppMenu();
  writeNavigationState("rules");
  elements.rulesPage.hidden = false;
  if (elements.mediaPage) elements.mediaPage.hidden = true;
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
  elements.subnav.innerHTML = "";
  elements.raceStatusBanner.hidden = true;
  renderNewsTicker();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function showMediaPage() {
  closeAppMenu();
  writeNavigationState("media");
  state.mediaMenuNoticed = true;
  updateMediaAlertBadges();
  if (elements.rulesPage) elements.rulesPage.hidden = true;
  elements.mediaPage.hidden = false;
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
  elements.subnav.innerHTML = "";
  elements.raceStatusBanner.hidden = true;
  renderNewsTicker();
  try {
    await loadMediaEntries();
  } catch {
    // Keep the existing list visible if a refresh fails.
  }
  renderMediaPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function returnToLeagueView() {
  activateSection(state.activeSection, state.activeViewBySection[state.activeSection]);
}

function openMediaDialog(entry = null) {
  state.editingMediaEntryId = entry?.id || null;
  elements.mediaDialogTitle.textContent = entry ? "Edit Entry" : "Add Entry";
  elements.mediaTitle.value = entry?.title || "";
  const showAuthorField = !entry && isStewardManager();
  elements.mediaAuthorField.hidden = !showAuthorField;
  elements.mediaAuthor.innerHTML = showAuthorField
    ? (state.mediaAuthorProfiles.length ? state.mediaAuthorProfiles : [{ username: state.managerUsername }])
      .map((profile) => `<option value="${escapeAttribute(profile.username)}">${escapeHtml(profile.username)}</option>`)
      .join("")
    : "";
  if (showAuthorField) elements.mediaAuthor.value = state.managerUsername;
  elements.mediaBody.value = entry?.body || "";
  elements.mediaMessage.textContent = "";
  elements.saveMediaEntry.textContent = entry ? "Save Changes" : "Save and Publish";
  elements.mediaDialog.showModal();
  elements.mediaTitle.focus();
}

async function saveMediaEntry(event) {
  event.preventDefault();
  elements.mediaMessage.textContent = "";
  elements.saveMediaEntry.disabled = true;
  const payload = {
    title: elements.mediaTitle.value,
    body: elements.mediaBody.value,
  };
  const editingId = state.editingMediaEntryId;
  if (!editingId && isStewardManager() && !elements.mediaAuthorField.hidden) {
    payload.authorUsername = elements.mediaAuthor.value;
  }
  try {
    const response = await fetch(editingId ? `/api/media/${editingId}` : "/api/media", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const entry = await response.json();
    if (!response.ok) throw new Error(entry.error || "Could not save media entry.");
    await loadMediaEntries();
    state.expandedMediaEntryId = entry.id;
    renderMediaPage();
    elements.mediaDialog.close();
  } catch (error) {
    elements.mediaMessage.textContent = error.message;
  } finally {
    elements.saveMediaEntry.disabled = false;
  }
}

async function deleteMediaEntry(id) {
  const entry = state.mediaEntries.find((item) => item.id === id);
  if (!entry || !window.confirm(`Delete "${entry.title}"?`)) return;
  const response = await fetch(`/api/media/${id}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) {
    window.alert(result.error || "Could not delete media entry.");
    return;
  }
  await loadMediaEntries();
  if (state.expandedMediaEntryId === id) state.expandedMediaEntryId = null;
  renderMediaPage();
}

document.querySelectorAll(".nav-link").forEach((button) => {
  button.addEventListener("click", async () => {
    closeAppMenu();
    if (button.dataset.section === "office") markDraftVoteAlertOfficeSeen();
    activateSection(button.dataset.section);
    if (button.dataset.section === "garage") {
      await loadRaceCenter();
      renderRaceControls();
      renderLineupEditor();
    } else {
      renderNewsTicker();
    }
  });
});

elements.subnav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-subview]");
  if (button) {
    if (state.activeSection === "office" && button.dataset.subview === "draft") {
      clearDraftVoteAlert();
    }
    activateSection(state.activeSection, button.dataset.subview);
  }
});

elements.lineupEditor.addEventListener("input", (event) => {
  if (event.target.matches("[data-laps-slot]")) {
    updateStintRanges();
  } else if (event.target.matches("[data-driver-slot]")) {
    const row = event.target.closest(".stint-row");
    const role = row?.querySelector(".stint-label")?.textContent;
    const performance = row?.querySelector(".relay-performance");
    if (performance && role) {
      performance.outerHTML = relayPerformanceMarkup(event.target.value, role);
    }
    updateLineupEligibility();
  }
});

elements.saveLineup.addEventListener("click", async () => {
  if (relayPlanRaceLockReason()) {
    updateLineupEligibility();
    return;
  }
  if (!state.relayPlanEditing) {
    state.relayPlanEditing = true;
    renderLineupEditor();
    elements.saveMessage.textContent = "";
    return;
  }
  const assignments = currentLineupAssignments();
  if (!updateLineupEligibility()) return;
  const carNames = state.carNames[state.selectedTeamId];
  elements.saveLineup.disabled = true;
  elements.saveMessage.classList.remove("error");
  elements.saveMessage.textContent = "Saving plan...";
  try {
    const response = await fetch(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineup: assignments, carNames }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save relay plan.");
    state.lineups[state.selectedTeamId] = result.lineup;
    state.carNames[state.selectedTeamId] = result.carNames;
    state.relayPlanEditing = false;
    renderLineupEditor();
    renderGarageCars();
    elements.saveMessage.textContent = "Relay plan saved.";
  } catch (error) {
    elements.saveMessage.classList.add("error");
    elements.saveMessage.textContent = error.message;
  } finally {
    updateLineupEligibility();
  }
});

elements.garageCars.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-edit-garage-car]");
  if (!button) return;
  const carIndex = Number(button.dataset.editGarageCar);
  const editor = elements.garageCars.querySelector(`[data-car-editor="${carIndex}"]`);
  const input = editor.querySelector(`[data-car-input="${carIndex}"]`);
  const display = editor.querySelector(`[data-car-display="${carIndex}"]`);
  const message = elements.garageCars.querySelector(`[data-car-message="${carIndex}"]`);

  if (input.hidden) {
    input.hidden = false;
    display.hidden = true;
    editor.classList.add("editing");
    input.focus();
    input.select();
    return;
  }

  const name = input.value.trim();
  button.disabled = true;
  message.textContent = "Saving car name...";
  try {
    const response = await fetch(
      `/api/teams/${encodeURIComponent(state.selectedTeamId)}/cars/${carIndex}/name`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not rename car.");
    state.carNames[state.selectedTeamId] = result.carNames;
    renderGarageCars();
    renderLineupEditor();
    renderInitialStandings();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});

function toggleRacerProfile(button) {
  const card = button.closest("[data-racer-card]");
  const expanded = card.querySelector(".racer-expanded");
  const shouldExpand = expanded.hidden;
  expanded.hidden = !shouldExpand;
  card.classList.toggle("expanded", shouldExpand);
  button.setAttribute("aria-expanded", String(shouldExpand));
  button.querySelector(".directory-expand-label").textContent = shouldExpand
    ? "Close profile"
    : "View profile";
}

elements.signedRacers.addEventListener("click", (event) => {
  const button = event.target.closest("[data-expand-racer]");
  if (button) toggleRacerProfile(button);
});

elements.freeAgentRacers.addEventListener("click", (event) => {
  const button = event.target.closest("[data-expand-racer]");
  if (button) toggleRacerProfile(button);
});

elements.teamProfile.addEventListener("click", (event) => {
  const button = event.target.closest("[data-expand-racer]");
  if (button) toggleRacerProfile(button);
});

elements.teamGrid.addEventListener("click", (event) => {
  const racerLink = event.target.closest("[data-team-racer]");
  if (!racerLink) return;
  const racerId = racerLink.dataset.teamRacer;
  activateSection("league", "signed");
  renderRacerDirectories();
  const card = elements.signedRacers.querySelector(`[data-racer-card="${racerId}"]`);
  const button = card?.querySelector("[data-expand-racer]");
  const expanded = card?.querySelector(".racer-expanded");
  if (!card || !button || !expanded) return;
  if (expanded.hidden) toggleRacerProfile(button);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});

elements.closeSeasonCeremony.addEventListener("click", closeSeasonCeremony);

elements.seasonChampions.addEventListener("click", (event) => {
  if (event.target.closest("[data-begin-next-season]")) {
    elements.nextSeasonDialog.showModal();
  }
});

elements.cancelNextSeason.addEventListener("click", () => {
  elements.nextSeasonDialog.close();
});

elements.confirmNextSeason.addEventListener("click", async () => {
  elements.confirmNextSeason.disabled = true;
  elements.confirmNextSeason.textContent = "Beginning season...";
  try {
    const response = await fetch("/api/seasons/next", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not begin the next season.");
    window.location.assign("/#");
  } catch (error) {
    elements.confirmNextSeason.disabled = false;
    elements.confirmNextSeason.textContent = "Begin next season";
    elements.developmentMessage.textContent = error.message;
    elements.nextSeasonDialog.close();
  }
});

elements.raceButton.addEventListener("click", startRace);

elements.raceHistory.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-race]");
  if (!button) return;
  if (button.dataset.reviewOpen === "true") {
    closeRaceReview();
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch(`/api/races/${button.dataset.reviewRace}`);
    const race = await response.json();
    if (!response.ok) throw new Error(race.error || "Could not load race review.");
    renderRaceReview(race, button);
  } catch (error) {
    elements.developmentMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.startDraft.addEventListener("click", async () => {
  elements.startDraft.disabled = true;
  elements.draftInitiationProgress.textContent = "Recording season initiation vote...";
  try {
    const response = await fetch("/api/draft/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poolSize: 60,
        teamId: managedTeamId(),
        leagueCode: elements.draftInitiationCode.value,
        veteranRetentionId: elements.draftRetainVeteran?.value || null,
        rookieRetentionId: elements.draftRetainRookie?.value || null,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not record season initiation vote.");
    state.draft = result;
    elements.draftInitiationCode.value = "";
    if (result.status === "not_started") {
      renderDraft();
      return;
    }
    elements.draftMessage.textContent = "Draft class generated. The opening draft has begun.";
    renderDraft();
    renderRaceControls();
    await renderIdleRaceFeed();
  } catch (error) {
    elements.draftInitiationProgress.textContent = error.message;
  } finally {
    renderDraft();
  }
});

elements.draftPool.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-draft-racer]");
  if (!button) return;
  button.disabled = true;
  elements.draftMessage.textContent = "Recording selection...";
  try {
    const response = await fetch("/api/draft/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ racerId: button.dataset.draftRacer }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not record pick.");
    state.draft = result;
    if (result.status === "complete") {
      await Promise.all([
        loadLeagueState(),
        loadRacerDirectory(),
        loadInitiationMartyr(),
      ]);
      renderInitialStandings();
      renderTeamProfile();
      renderLineupEditor();
      renderGarageCars();
      renderLeague();
      renderRacerDirectories();
      elements.draftMessage.textContent = "Draft complete. The new rosters are active.";
      renderInitiationMartyrVote();
      renderRaceControls();
    } else {
      const nextTeam = teams.find((team) => team.id === result.currentTeamId);
      elements.draftMessage.textContent = `${nextTeam.name} is now on the clock.`;
    }
    renderDraft();
  } catch (error) {
    elements.draftMessage.textContent = error.message;
    button.disabled = false;
  }
});

elements.draftSort.addEventListener("change", renderDraft);
elements.draftRetainVeteran?.addEventListener("change", renderDraftInitiation);
elements.draftRetainRookie?.addEventListener("change", renderDraftInitiation);
elements.rookieDraftSort.addEventListener("change", renderRookieDraft);

elements.startRookieDraft.addEventListener("click", async () => {
  elements.startRookieDraft.disabled = true;
  elements.rookieDraftInitiationProgress.textContent = "Recording rookie draft vote...";
  try {
    const response = await fetch("/api/rookie-draft/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leagueCode: elements.rookieDraftInitiationCode.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not record rookie draft vote.");
    state.rookieDraft = result;
    elements.rookieDraftInitiationCode.value = "";
    renderRookieDraft();
    renderRaceControls();
    renderNewsTicker();
  } catch (error) {
    elements.rookieDraftInitiationProgress.textContent = error.message;
  } finally {
    renderRookieDraft();
  }
});

elements.rookieDraftPool.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rookie-draft-racer]");
  if (!button) return;
  button.disabled = true;
  elements.rookieDraftMessage.textContent = "Recording rookie selection...";
  try {
    const response = await fetch("/api/rookie-draft/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ racerId: button.dataset.rookieDraftRacer }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not draft that rookie.");
    state.rookieDraft = result;
    await Promise.all([loadLeagueState(), loadRacerDirectory(), loadTransactions()]);
    renderRookieDraft();
    renderTeamProfile();
    renderRacerDirectories();
    renderTransactions();
    renderRaceControls();
    elements.rookieDraftMessage.textContent = result.status === "releases"
      ? "Both rounds are complete. Every team must now release one racer."
      : "Selection recorded. The next team is on the clock.";
  } catch (error) {
    elements.rookieDraftMessage.textContent = error.message;
    button.disabled = false;
  }
});

elements.submitRookieRelease.addEventListener("click", async () => {
  elements.submitRookieRelease.disabled = true;
  elements.rookieDraftMessage.textContent = "Processing roster release...";
  try {
    const response = await fetch("/api/rookie-draft/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: managedTeamId(),
        racerId: elements.rookieReleaseRacer.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not release that racer.");
    state.rookieDraft = result;
    await Promise.all([loadLeagueState(), loadRacerDirectory(), loadTransactions()]);
    renderRookieDraft();
    renderTeamProfile();
    renderLineupEditor();
    renderRacerDirectories();
    renderTransactions();
    renderRaceControls();
    elements.rookieDraftMessage.textContent = result.status === "complete"
      ? "Roster releases complete. Race 11 may begin."
      : "Racer released. Remaining teams must finalize their rosters.";
  } catch (error) {
    elements.rookieDraftMessage.textContent = error.message;
    elements.submitRookieRelease.disabled = false;
  }
});

elements.submitMartyrVote.addEventListener("click", async () => {
  elements.submitMartyrVote.disabled = true;
  elements.martyrVoteMessage.textContent = "The Stewards are recording this judgment...";
  try {
    const response = await fetch("/api/initiation-martyr/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: managedTeamId(),
        racerId: elements.martyrCandidate.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not cast the martyr vote.");
    state.martyr = result;
    if (result.status === "resolved") {
      elements.martyrVoteDialog.close();
      await Promise.all([loadTransactions(), loadRacerDirectory(), loadInMemoriam()]);
      renderTransactions();
      renderRacerDirectories();
      renderInMemoriam();
      renderRaceControls();
      showInitiationMartyrResult(result.martyr);
    } else {
      renderInitiationMartyrVote();
    }
  } catch (error) {
    elements.martyrVoteMessage.textContent = error.message;
    elements.submitMartyrVote.disabled = false;
  }
});

elements.martyrVoteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
});

elements.closeMartyrResult.addEventListener("click", () => {
  elements.martyrResultDialog.close();
});

elements.signedRacerSort.addEventListener("change", renderRacerDirectories);
elements.freeAgentRacerSort.addEventListener("change", renderRacerDirectories);

elements.tradeTeam.addEventListener("change", renderMoveSelectors);

elements.proposeTrade.addEventListener("click", async () => {
  elements.proposeTrade.disabled = true;
  elements.movesMessage.textContent = "Sending trade offer...";
  try {
    const response = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offeringTeamId: managedTeamId(),
        receivingTeamId: elements.tradeTeam.value,
        offeredRacerId: elements.tradeOffered.value,
        requestedRacerId: elements.tradeRequested.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not send trade offer.");
    await loadTransactions();
    renderTransactions();
    elements.movesMessage.textContent = "Trade offer sent.";
  } catch (error) {
    elements.movesMessage.textContent = error.message;
  } finally {
    elements.proposeTrade.disabled = false;
  }
});

elements.tradeOffers.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-trade-id]");
  if (!button) return;
  button.disabled = true;
  elements.movesMessage.textContent = `${button.dataset.action === "accept" ? "Accepting" : "Rejecting"} trade...`;
  try {
    const response = await fetch(`/api/trades/${button.dataset.tradeId}/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: button.dataset.action }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not resolve trade.");
    await refreshLeagueAndTransactions();
    elements.movesMessage.textContent = `Trade ${button.dataset.action === "accept" ? "accepted" : "rejected"}.`;
  } catch (error) {
    elements.movesMessage.textContent = error.message;
    button.disabled = false;
  }
});

elements.signFreeAgent.addEventListener("click", async () => {
  elements.signFreeAgent.disabled = true;
  elements.movesMessage.textContent = "Completing free-agent move...";
  try {
    const response = await fetch("/api/free-agency/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: managedTeamId(),
        freeAgentId: elements.freeAgent.value,
        releasedRacerId: elements.releaseRacer.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not complete free-agent move.");
    await refreshLeagueAndTransactions();
    elements.movesMessage.textContent = "Free-agent move completed.";
  } catch (error) {
    elements.movesMessage.textContent = error.message;
  } finally {
    elements.signFreeAgent.disabled = false;
  }
});

async function saveBrandChange({ button, element, value, teamId }) {
  button.disabled = true;
  elements.brandMessage.textContent = "Updating team brand...";
  try {
    const response = await fetch(
      `/api/teams/${encodeURIComponent(teamId)}/brand`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ element, value }),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update team brand.");
    await Promise.all([loadLeagueState(), loadRaceCenter(), loadRacerDirectory()]);
    applyTeamTheme(teamId);
    renderBrand();
    renderTeamPicker();
    renderTeamProfile();
    renderLineupEditor();
    renderGarageCars();
    renderLeague();
    renderTransactions();
    renderDevelopment();
    renderRacerDirectories();
    renderRaceArchive();
    renderInitialStandings();
    renderRaceControls();
    elements.brandMessage.textContent = element === "color"
      ? "Team color updated."
      : `${titleCase(element)} updated for Season ${state.raceCenter.season}.`;
  } catch (error) {
    elements.brandMessage.textContent = error.message;
    button.disabled = false;
  }
}

elements.brandEditor.addEventListener("click", (event) => {
  const button = event.target.closest("[data-save-brand]");
  if (!button) return;
  const element = button.dataset.saveBrand;
  let value;
  if (element === "color") {
    value = elements.brandEditor.querySelector('input[name="brand-color"]:checked')?.value;
  } else {
    value = elements.brandEditor.querySelector(`[data-brand-value="${element}"]`)?.value;
  }
  if (!value) {
    elements.brandMessage.textContent = "Choose a value before saving.";
    return;
  }
  if (element === "abbreviation" && !/^[A-Za-z0-9]{3}$/.test(value.trim())) {
    elements.brandMessage.textContent = "The abbreviation must contain exactly 3 letters or numbers.";
    return;
  }
  pendingBrandChange = {
    button,
    element,
    value,
    teamId: managedTeamId(),
  };
  elements.brandConfirmMessage.textContent = element === "color"
    ? "Changing your team color will also change your main button color. Are you sure you want to make the change?"
    : "This element of your team brand may only be changed once per season. Are you sure you want to make the change?";
  elements.brandConfirmDialog.showModal();
  elements.cancelBrandChange.focus();
});

elements.brandEditor.addEventListener("input", (event) => {
  if (event.target.matches('[data-brand-value="abbreviation"]')) {
    updateAbbreviationEligibility();
  } else if (event.target.matches('input[name="brand-color"]')) {
    updateColorEligibility();
  }
});

elements.brandEditor.addEventListener("change", (event) => {
  if (event.target.matches('input[name="brand-color"]')) {
    updateColorEligibility();
  }
});

elements.cancelBrandChange.addEventListener("click", () => {
  pendingBrandChange = null;
  elements.brandConfirmDialog.close();
});

elements.confirmBrandChange.addEventListener("click", async () => {
  if (!pendingBrandChange) return;
  const change = pendingBrandChange;
  pendingBrandChange = null;
  elements.brandConfirmDialog.close();
  await saveBrandChange(change);
});

elements.brandConfirmDialog.addEventListener("cancel", () => {
  pendingBrandChange = null;
});

elements.upgradeOptions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-upgrade-option]");
  if (!button) return;
  const optionIndex = Number(button.dataset.upgradeOption);
  const racerSelect = elements.upgradeOptions.querySelector(
    `[data-upgrade-racer="${optionIndex}"]`,
  );
  button.disabled = true;
  elements.developmentMessage.textContent = "Testing hidden potential...";
  try {
    const response = await fetch("/api/development/choose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: managedTeamId(),
        racerId: racerSelect.value,
        optionIndex,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not lock in weekly training.");
    await Promise.all([loadLeagueState(), loadDevelopment()]);
    renderTeamProfile();
    renderLineupEditor();
    renderGarageCars();
    renderDevelopment();
    renderBrand();
    elements.developmentMessage.textContent = result.appliedAt
      ? result.result === "improved"
        ? `${result.racer.name} improved ${titleCase(result.stat)}.`
        : `${result.racer.name} has no ordinary ${titleCase(result.stat)} potential remaining. Cap discovered.`
      : `${result.racer.name} is locked in for ${titleCase(result.stat)} Training. It will take effect Sunday at 12:01 AM Eastern.`;
  } catch (error) {
    elements.developmentMessage.textContent = error.message;
    button.disabled = false;
  }
});

elements.carUpgradeOptions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-car-upgrade-option]");
  if (!button) return;
  const optionIndex = Number(button.dataset.carUpgradeOption);
  const carSelect = elements.carUpgradeOptions.querySelector(
    `[data-upgrade-car="${optionIndex}"]`,
  );
  button.disabled = true;
  elements.developmentMessage.textContent = "Installing weekly car upgrade...";
  try {
    const response = await fetch("/api/development/choose-car", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: managedTeamId(),
        carIndex: Number(carSelect.value),
        optionIndex,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not lock in car upgrade.");
    await Promise.all([loadLeagueState(), loadDevelopment()]);
    renderGarageCars();
    renderDevelopment();
    const carName = state.carNames[result.teamId][result.carIndex];
    elements.developmentMessage.textContent = result.appliedAt
      ? `${carName} improved ${titleCase(result.stat)}.`
      : `${carName} is locked in for a ${titleCase(result.stat)} Upgrade. It will take effect Sunday at 12:01 AM Eastern.`;
  } catch (error) {
    elements.developmentMessage.textContent = error.message;
    button.disabled = false;
  }
});

async function runStewardsAction(action, button = null) {
  const routes = {
    "next-race": ["/api/races", "Starting next race..."],
    "finish-race": ["/api/stewards/finish-active-race", "Finishing current race..."],
    "race-10": ["/api/stewards/fast-forward-race-10", "Fast forwarding to Race 10..."],
    "skip-opening-draft": ["/api/stewards/skip-opening-draft", "Skipping opening draft and choosing an Initiation Martyr..."],
    "auto-rookie-releases": ["/api/stewards/auto-rookie-releases", "Auto-completing rookie roster releases..."],
    "next-season": ["/api/seasons/next", "Starting next season..."],
    "reset-season": ["/api/stewards/reset-season-races", "Resetting current season races..."],
  };
  const [route, workingMessage] = routes[action] || [];
  if (!route) return;
  if (button) button.disabled = true;
  elements.stewardsMessage.classList.remove("error");
  elements.stewardsMessage.textContent = workingMessage;
  try {
    const response = await fetch(route, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The Stewards could not complete that action.");
    await refreshAfterStewardsAction(result);
    elements.stewardsMessage.textContent = "Stewards action completed.";
  } catch (error) {
    elements.stewardsMessage.classList.add("error");
    elements.stewardsMessage.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

elements.stewardsPanel.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-stewards-action]");
  if (!button) return;
  const action = button.dataset.stewardsAction;
  if (action === "reset-season") {
    elements.stewardsResetDialog.showModal();
    return;
  }
  await runStewardsAction(action, button);
});

elements.cancelStewardsReset.addEventListener("click", () => elements.stewardsResetDialog.close());
elements.confirmStewardsReset.addEventListener("click", async () => {
  elements.stewardsResetDialog.close();
  await runStewardsAction("reset-season");
});

async function initialize() {
  elements.saveLineup.disabled = true;
  elements.raceButton.disabled = true;
  try {
    await Promise.all([
      loadLeagueState(),
      loadDraft(),
      loadRookieDraft(),
      loadInitiationMartyr(),
      loadTransactions(),
      loadDevelopment(),
      loadRaceCenter(),
      loadRacerDirectory(),
      loadInMemoriam(),
      loadMediaEntries(),
    ]);
  } catch (error) {
    elements.saveMessage.textContent = `${error.message} Using temporary defaults.`;
  } finally {
    applySeasonCeremonyPreview();
    renderInitialStandings();
    renderTeamPicker();
    renderTeamProfile();
    renderLineupEditor();
    renderGarageCars();
    renderLeague();
    renderDraft();
    renderRookieDraft();
    renderTransactions();
    renderDevelopment();
    renderBrand();
    renderRaceArchive();
    renderCourses();
    renderRacerDirectories();
    renderInMemoriam();
    renderMediaPage();
    const navigationMode = restoreNavigationState();
    activateSection(state.activeSection, state.activeViewBySection[state.activeSection]);
    renderRaceControls();
    renderInitiationMartyrVote();
    if (state.raceCenter.raceActive && state.raceCenter.activeRaceId) {
      const response = await fetch(`/api/races/${state.raceCenter.activeRaceId}`);
      const activeRace = await response.json();
      if (response.ok) {
        state.activeLeagueRace = activeRace;
        elements.speed.value = "1";
        playRace(
          activeRace,
          false,
          raceElapsedSinceStart(activeRace.startAt),
        );
      }
    } else {
      await renderIdleRaceFeed();
    }
    showSeasonCeremony({ automatic: !isSeasonCeremonyPreview() });
    if (navigationMode === "rules") showRulesPage();
    if (navigationMode === "media") await showMediaPage();
  }
}

async function syncRaceCenter() {
  const ceremonyWasAvailable = Boolean(state.raceCenter.seasonComplete && state.raceCenter.champions);
  const priorRelayLockReason = relayPlanRaceLockReason();
  await loadRaceCenter();
  const nextRelayLockReason = relayPlanRaceLockReason();
  const ceremonyIsNewlyAvailable = !ceremonyWasAvailable
    && state.raceCenter.seasonComplete
    && state.raceCenter.champions;
  if (!state.running && state.raceCenter.raceActive && state.raceCenter.activeRaceId) {
    const response = await fetch(`/api/races/${state.raceCenter.activeRaceId}`);
    const activeRace = await response.json();
    if (response.ok) {
      state.activeLeagueRace = activeRace;
      elements.speed.value = "1";
      playRace(
        activeRace,
        false,
        raceElapsedSinceStart(activeRace.startAt),
      );
      renderLineupEditor();
    }
  } else if (!state.running) {
    if (ceremonyIsNewlyAvailable) {
      await Promise.all([loadLeagueState(), loadRacerDirectory(), loadInMemoriam()]);
      renderTeamProfile();
      renderLeague();
      renderRacerDirectories();
      renderInMemoriam();
      renderRaceArchive();
    }
    renderRaceControls();
    if (priorRelayLockReason !== nextRelayLockReason) renderLineupEditor();
    await renderIdleRaceFeed();
    if (state.raceCenter.seasonComplete && state.raceCenter.champions) {
      showSeasonCeremony({ automatic: true });
    }
  }
}

function draftSyncSignature(draft = state.draft) {
  return [
    draft.status,
    draft.currentPick,
    draft.currentRound,
    draft.currentTeamId,
    draft.picks?.length || 0,
    draft.pool?.length || 0,
    draft.initiation?.voteCount || 0,
  ].join("|");
}

async function syncDraft() {
  if (!["not_started", "active"].includes(state.draft.status)) return;
  const previousSignature = draftSyncSignature();
  await loadDraft();
  const nextSignature = draftSyncSignature();
  if (previousSignature !== nextSignature) {
    await Promise.all([
      loadLeagueState(),
      loadRacerDirectory(),
      loadInitiationMartyr(),
    ]);
    renderInitialStandings();
    renderTeamProfile();
    renderLineupEditor();
    renderGarageCars();
    renderLeague();
    renderRacerDirectories();
    renderInitiationMartyrVote();
  }
  renderDraft();
  renderRaceControls();
}

function martyrSyncSignature(martyr = state.martyr) {
  return [
    martyr.status,
    martyr.votes?.length || 0,
    martyr.martyr?.id || "",
    (martyr.votes || []).map((vote) => `${vote.team_id}:${vote.racer_id}`).sort().join(","),
  ].join("|");
}

async function syncInitiationMartyr() {
  if (!["voting", "resolved"].includes(state.martyr.status)) return;
  const previousSignature = martyrSyncSignature();
  const wasVoting = state.martyr.status === "voting";
  await loadInitiationMartyr();
  const nextSignature = martyrSyncSignature();
  if (previousSignature === nextSignature) return;
  if (state.martyr.status === "resolved") {
    if (elements.martyrVoteDialog.open) elements.martyrVoteDialog.close();
    await Promise.all([loadTransactions(), loadRacerDirectory(), loadInMemoriam()]);
    renderTransactions();
    renderRacerDirectories();
    renderInMemoriam();
    renderRaceControls();
    renderNewsTicker();
    if (wasVoting && state.martyr.martyr) {
      showInitiationMartyrResult(state.martyr.martyr);
    }
    return;
  }
  renderInitiationMartyrVote();
  renderRaceControls();
}

async function syncRookieDraft() {
  if (!["voting", "active", "releases"].includes(state.rookieDraft.status)) return;
  const previousSignature = [
    state.rookieDraft.status,
    state.rookieDraft.currentPick,
    state.rookieDraft.currentRound,
    state.rookieDraft.currentTeamId,
    state.rookieDraft.picks?.length || 0,
    state.rookieDraft.releases?.length || 0,
    state.rookieDraft.pool?.length || 0,
    state.rookieDraft.initiation?.voteCount || 0,
  ].join("|");
  await loadRookieDraft();
  const nextSignature = [
    state.rookieDraft.status,
    state.rookieDraft.currentPick,
    state.rookieDraft.currentRound,
    state.rookieDraft.currentTeamId,
    state.rookieDraft.picks?.length || 0,
    state.rookieDraft.releases?.length || 0,
    state.rookieDraft.pool?.length || 0,
    state.rookieDraft.initiation?.voteCount || 0,
  ].join("|");
  if (previousSignature !== nextSignature) {
    await loadLeagueState();
    await loadRacerDirectory();
    renderTeamProfile();
    renderRacerDirectories();
    renderLineupEditor();
  }
  renderRookieDraft();
  renderRaceControls();
}

async function syncTransactions() {
  const previousOfferIds = state.transactions.offers.map((offer) => `${offer.id}:${offer.status}`).join("|");
  await loadTransactions();
  const nextOfferIds = state.transactions.offers.map((offer) => `${offer.id}:${offer.status}`).join("|");
  if (previousOfferIds !== nextOfferIds) {
    renderTransactions();
  }
}

async function syncMediaEntries() {
  const previousSignature = [
    state.mediaEntries.map((entry) => `${entry.id}:${entry.updatedAt}`).join("|"),
    state.unreadMediaEntryIds.join(","),
  ].join("::");
  await loadMediaEntries();
  const nextSignature = [
    state.mediaEntries.map((entry) => `${entry.id}:${entry.updatedAt}`).join("|"),
    state.unreadMediaEntryIds.join(","),
  ].join("::");
  if (previousSignature !== nextSignature) renderMediaPage();
}

async function startApp() {
  if (appStarted) {
    showGameShell();
    stabilizeInitialLayout();
    return;
  }
  try {
    await initialize();
    showGameShell();
    renderNewsTicker();
    stabilizeInitialLayout();
    raceCenterInterval = setInterval(syncRaceCenter, 2_000);
    draftInterval = setInterval(syncDraft, 2_000);
    rookieDraftInterval = setInterval(syncRookieDraft, 2_000);
    martyrInterval = setInterval(syncInitiationMartyr, 2_000);
    transactionsInterval = setInterval(syncTransactions, 15_000);
    mediaInterval = setInterval(syncMediaEntries, 15_000);
    appStarted = true;
  } catch (error) {
    appStarted = false;
    showAuthError(error.message || "Could not start the league.");
    throw error;
  }
}

elements.showLogin.addEventListener("click", () => setAuthMode("login"));
elements.showRegister.addEventListener("click", () => setAuthMode("register"));
elements.appMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAppMenu();
});
elements.openRules.addEventListener("click", showRulesPage);
elements.openMedia.addEventListener("click", showMediaPage);
elements.openWiki.addEventListener("click", () => {
  closeAppMenu();
});
elements.menuLogout.addEventListener("click", () => {
  closeAppMenu();
  elements.logoutDialog.showModal();
});
elements.closeRules.addEventListener("click", returnToLeagueView);
elements.addMediaEntry.addEventListener("click", () => openMediaDialog());
elements.cancelMediaEntry.addEventListener("click", () => elements.mediaDialog.close());
elements.mediaForm.addEventListener("submit", saveMediaEntry);
elements.mediaList.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-media-edit]");
  if (editButton) {
    const entry = state.mediaEntries.find((item) => item.id === Number(editButton.dataset.mediaEdit));
    if (entry) openMediaDialog(entry);
    return;
  }
  const deleteButton = event.target.closest("[data-media-delete]");
  if (deleteButton) {
    await deleteMediaEntry(Number(deleteButton.dataset.mediaDelete));
    return;
  }
  const toggleButton = event.target.closest("[data-media-toggle]");
  if (toggleButton) {
    const id = Number(toggleButton.dataset.mediaToggle);
    state.expandedMediaEntryId = state.expandedMediaEntryId === id ? null : id;
    if (state.expandedMediaEntryId === id) {
      await markMediaEntrySeen(id);
    }
    renderMediaPage();
  }
});
document.addEventListener("click", (event) => {
  if (!elements.appMenu.hidden && !event.target.closest(".app-menu-shell")) {
    closeAppMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.appMenu.hidden) closeAppMenu();
});
elements.cancelLogout.addEventListener("click", () => elements.logoutDialog.close());
elements.confirmLogout.addEventListener("click", async () => {
  try {
    await fetch("/api/managers/logout", { method: "POST" });
  } catch {
    // Local cleanup still logs the browser out if the network request fails.
  }
  clearInterval(draftInterval);
  clearInterval(rookieDraftInterval);
  clearInterval(martyrInterval);
  clearInterval(raceCenterInterval);
  clearInterval(transactionsInterval);
  clearInterval(mediaInterval);
  window.localStorage.removeItem(managerStorageKey);
  window.localStorage.removeItem(managerTeamStorageKey);
  window.location.reload();
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await submitManagerAuth("/api/managers/login", elements.loginForm);
  } catch (error) {
    showAuthError(error.message);
  }
});

elements.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await submitManagerAuth("/api/managers/register", elements.registerForm);
  } catch (error) {
    showAuthError(error.message);
  }
});

const savedManagerTeamId = window.localStorage.getItem(managerTeamStorageKey);
if (savedManagerTeamId && teams.some((team) => team.id === savedManagerTeamId)) {
  state.managerTeamId = savedManagerTeamId;
  state.selectedTeamId = savedManagerTeamId;
}

window.addEventListener("resize", () => {
  if (tickerResizeFrame) window.cancelAnimationFrame(tickerResizeFrame);
  tickerResizeFrame = window.requestAnimationFrame(() => {
    tickerResizeFrame = null;
    calibrateNewsTicker();
  });
});

if (window.localStorage.getItem(managerStorageKey)) {
  restoreManagerSession().catch(() => {
    window.localStorage.removeItem(managerStorageKey);
    window.localStorage.removeItem(managerTeamStorageKey);
    setAuthMode("login");
  });
} else {
  setAuthMode("login");
}
