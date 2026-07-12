import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLeagueStore } from "./league-store.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const store = createLeagueStore(process.env.ASSCAR_DB_PATH || join(root, "work", "asscar60.sqlite"));
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
let schedulerBusy = false;

function isSecureRequest(request) {
  return request.headers["x-forwarded-proto"] === "https"
    || request.socket.encrypted
    || false;
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .map((cookie) => {
      const index = cookie.indexOf("=");
      return index === -1
        ? [decodeURIComponent(cookie), ""]
        : [decodeURIComponent(cookie.slice(0, index)), decodeURIComponent(cookie.slice(index + 1))];
    }));
}

function sessionCookie(sessionId, request, { clear = false } = {}) {
  const parts = [
    `asscar_session=${clear ? "" : encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (clear) parts.push("Max-Age=0");
  else parts.push("Max-Age=2592000");
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function createSession(manager, request, response) {
  const sessionId = randomBytes(32).toString("hex");
  store.createManagerSession(sessionId, manager);
  response.setHeader("Set-Cookie", sessionCookie(sessionId, request));
  return manager;
}

function currentSession(request) {
  const sessionId = parseCookies(request).asscar_session;
  if (!sessionId) return null;
  return store.getManagerSession(sessionId);
}

function requireManager(request) {
  const session = currentSession(request);
  if (!session?.teamId) {
    const error = new Error("Please log in first.");
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function assertOwnTeam(request, teamId) {
  const manager = requireManager(request);
  if (String(teamId) !== String(manager.teamId)) {
    const error = new Error("You can only manage your assigned team.");
    error.statusCode = 403;
    throw error;
  }
  return manager;
}

function requireStewards(request) {
  const session = currentSession(request);
  if (session?.username === "devman") return;
  const error = new Error("Stewards controls are disabled online.");
  error.statusCode = 403;
  throw error;
}

function scheduledRaceActivationAt(center) {
  if (!center.nextRaceAt) return null;
  const raceAt = new Date(center.nextRaceAt);
  return new Date(raceAt.getTime() - (center.seasonRacesRun === 0 ? 60_000 : 0));
}

function runRaceScheduler() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const season = store.getActiveSeason();
    store.maintainRookieDraft(season);
    const center = store.getRaceCenter(season);
    if (center.raceActive && center.activeRaceId) {
      const race = store.getRace(center.activeRaceId);
      const finishAt = new Date(race.startAt).getTime() + (race.duration * 1000);
      if (Date.now() >= finishAt) store.finishRace(race.id);
      return;
    }
    const activationAt = scheduledRaceActivationAt(center);
    if (!activationAt || Date.now() < activationAt.getTime()) return;
    store.createRace({
      season,
      startAt: center.nextRaceAt,
      seed: `scheduled-season-${season}-race-${center.seasonRacesRun + 1}`,
    });
  } catch {
    // Drafts and votes intentionally block scheduled creation until resolved.
  } finally {
    schedulerBusy = false;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 100_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const requestedPath = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (request.method === "POST" && requestedPath === "/api/managers/register") {
      sendJson(response, 201, createSession(store.registerManager(await readJson(request)), request, response));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/managers/login") {
      sendJson(response, 200, createSession(store.loginManager(await readJson(request)), request, response));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/managers/session") {
      const session = currentSession(request);
      if (!session) {
        sendJson(response, 401, { error: "No active session." });
        return;
      }
      sendJson(response, 200, { username: session.username, teamId: session.teamId });
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/managers/logout") {
      const sessionId = parseCookies(request).asscar_session;
      if (sessionId) store.removeManagerSession(sessionId);
      response.setHeader("Set-Cookie", sessionCookie("", request, { clear: true }));
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/league-state") {
      sendJson(response, 200, store.getLeagueState());
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/draft") {
      sendJson(response, 200, store.getDraft());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/draft/start") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(response, 201, store.voteToStartDraft({ ...input, teamId: manager.teamId }));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/draft/picks") {
      const input = await readJson(request);
      const manager = requireManager(request);
      const draft = store.getDraft();
      if (draft.currentTeamId !== manager.teamId) {
        const error = new Error("It is not your team's draft pick.");
        error.statusCode = 403;
        throw error;
      }
      sendJson(response, 201, store.makeDraftPick(String(input.racerId)));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/rookie-draft") {
      sendJson(response, 200, store.getRookieDraft(store.getActiveSeason()));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/rookie-draft/picks") {
      const input = await readJson(request);
      const manager = requireManager(request);
      const draft = store.getRookieDraft(store.getActiveSeason());
      if (draft.currentTeamId !== manager.teamId) {
        const error = new Error("It is not your team's rookie draft pick.");
        error.statusCode = 403;
        throw error;
      }
      sendJson(response, 201, store.makeRookieDraftPick(
        String(input.racerId),
        store.getActiveSeason(),
      ));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/rookie-draft/releases") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(
        response,
        201,
        store.releaseRacerAfterRookieDraft(
          manager.teamId,
          String(input.racerId),
          store.getActiveSeason(),
        ),
      );
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/initiation-martyr") {
      sendJson(response, 200, store.getInitiationMartyr(store.getActiveSeason()));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/in-memoriam") {
      sendJson(response, 200, store.getInMemoriam());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/initiation-martyr/votes") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(
        response,
        201,
        store.voteForInitiationMartyr(
          manager.teamId,
          String(input.racerId),
          store.getActiveSeason(),
        ),
      );
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/transactions") {
      sendJson(response, 200, store.getTransactions(currentSession(request) || {}));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/transactions/alerts/seen") {
      const manager = requireManager(request);
      sendJson(response, 200, store.markTradeAlertsSeen(manager.username, manager.teamId));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/racers") {
      sendJson(response, 200, store.getRacerDirectory());
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/development") {
      const season = store.getActiveSeason();
      const week = store.getRaceCenter(season).week;
      sendJson(response, 200, store.getDevelopment(((season - 1) * 4) + week));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/races") {
      sendJson(response, 200, store.getRaceCenter(store.getActiveSeason()));
      return;
    }

    if (request.method === "GET" && requestedPath === "/api/seasons") {
      sendJson(response, 200, store.getSeasonHistory());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/races") {
      requireStewards(request);
      sendJson(response, 201, store.createRace({ season: store.getActiveSeason() }));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/seasons/next") {
      requireStewards(request);
      sendJson(response, 201, store.beginNextSeason());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/finish-active-race") {
      requireStewards(request);
      sendJson(response, 200, store.finishActiveRaceNow());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/fast-forward-race-10") {
      requireStewards(request);
      sendJson(response, 200, store.fastForwardToRace10());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/auto-pick-draft") {
      requireStewards(request);
      sendJson(response, 200, store.autoPickCurrentDraft());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/skip-opening-draft") {
      requireStewards(request);
      sendJson(response, 200, store.skipOpeningDraftAndMartyr());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/auto-rookie-releases") {
      requireStewards(request);
      sendJson(response, 200, store.autoCompleteRookieReleases());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/reset-season-races") {
      requireStewards(request);
      sendJson(response, 200, store.resetActiveSeasonRaces());
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/stewards/restart-season") {
      requireStewards(request);
      sendJson(response, 200, store.restartActiveSeason());
      return;
    }

    const raceMatch = requestedPath.match(/^\/api\/races\/(\d+)$/);
    if (request.method === "GET" && raceMatch) {
      sendJson(response, 200, store.getRace(Number(raceMatch[1])));
      return;
    }

    const finishRaceMatch = requestedPath.match(/^\/api\/races\/(\d+)\/finish$/);
    if (request.method === "POST" && finishRaceMatch) {
      const raceId = Number(finishRaceMatch[1]);
      const race = store.getRace(raceId);
      const finishAt = new Date(race.startAt).getTime() + (race.duration * 1000);
      sendJson(
        response,
        200,
        Date.now() >= finishAt
          ? store.finishRace(raceId)
          : store.getRaceCenter(store.getActiveSeason()),
      );
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/races/participation") {
      const input = await readJson(request);
      const manager = requireManager(request);
      const season = store.getActiveSeason();
      const week = store.getRaceCenter(season).week;
      sendJson(response, 201, store.recordRaceParticipation(
        input.participants?.filter((participant) => participant.teamId === manager.teamId),
        ((season - 1) * 4) + week,
      ));
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/development/choose") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(
        response,
        201,
        store.chooseWeeklyUpgrade(
          manager.teamId,
          String(input.racerId),
          Number(input.optionIndex),
          ((store.getActiveSeason() - 1) * 4)
            + store.getRaceCenter(store.getActiveSeason()).week,
        ),
      );
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/development/choose-car") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(
        response,
        201,
        store.chooseWeeklyCarUpgrade(
          manager.teamId,
          Number(input.carIndex),
          Number(input.optionIndex),
          ((store.getActiveSeason() - 1) * 4)
            + store.getRaceCenter(store.getActiveSeason()).week,
        ),
      );
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/trades") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(response, 201, store.proposeTrade({
        ...input,
        offeringTeamId: manager.teamId,
      }));
      return;
    }

    const tradeMatch = requestedPath.match(/^\/api\/trades\/(\d+)\/response$/);
    if (request.method === "POST" && tradeMatch) {
      const input = await readJson(request);
      const manager = requireManager(request);
      const offer = store.getTransactions(manager).offers.find((item) => item.id === Number(tradeMatch[1]));
      if (!offer || offer.receiving_team_id !== manager.teamId) {
        const error = new Error("Only the receiving team can respond to this trade.");
        error.statusCode = 403;
        throw error;
      }
      sendJson(
        response,
        200,
        store.respondToTrade(Number(tradeMatch[1]), String(input.action)),
      );
      return;
    }

    if (request.method === "POST" && requestedPath === "/api/free-agency/sign") {
      const input = await readJson(request);
      const manager = requireManager(request);
      sendJson(
        response,
        201,
        store.signFreeAgent(
          manager.teamId,
          String(input.freeAgentId),
          String(input.releasedRacerId),
        ),
      );
      return;
    }

    const planMatch = requestedPath.match(/^\/api\/teams\/([^/]+)\/plan$/);
    if (request.method === "PUT" && planMatch) {
      assertOwnTeam(request, decodeURIComponent(planMatch[1]));
      const result = store.saveTeamPlan(
        decodeURIComponent(planMatch[1]),
        await readJson(request),
      );
      sendJson(response, 200, result);
      return;
    }

    const carNameMatch = requestedPath.match(/^\/api\/teams\/([^/]+)\/cars\/([01])\/name$/);
    if (request.method === "PUT" && carNameMatch) {
      assertOwnTeam(request, decodeURIComponent(carNameMatch[1]));
      const input = await readJson(request);
      sendJson(
        response,
        200,
        store.renameCar(
          decodeURIComponent(carNameMatch[1]),
          Number(carNameMatch[2]),
          input.name,
        ),
      );
      return;
    }

    const brandMatch = requestedPath.match(/^\/api\/teams\/([^/]+)\/brand$/);
    if (request.method === "PUT" && brandMatch) {
      assertOwnTeam(request, decodeURIComponent(brandMatch[1]));
      const input = await readJson(request);
      sendJson(
        response,
        200,
        store.updateTeamBrand(
          decodeURIComponent(brandMatch[1]),
          String(input.element),
          input.value,
          store.getActiveSeason(),
        ),
      );
      return;
    }

    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");

    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(await readFile(filePath));
  } catch (error) {
    if (request.url?.startsWith("/api/")) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    } else {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  }
});

server.listen(port, host, () => {
  console.log(`ASSCAR60 running at http://${host}:${port}`);
  runRaceScheduler();
  setInterval(runRaceScheduler, 1_000);
});
