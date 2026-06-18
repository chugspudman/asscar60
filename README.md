# ASSCAR60

A first playable prototype of a private six-manager fantasy relay-racing simulator.

## Run

```powershell
& "C:\Users\thebu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
```

Then open `http://127.0.0.1:4173`.

The race screen defaults to 60x playback for demonstration. Select `Live 1x` for the intended 40-70 minute race presentation.

## Included

- Six whimsical teams with two cars each
- Public racer ratings and Potential
- Persistent editable three-stint default relay plans
- Server-owned SQLite storage shared by every browser
- Deterministic 60-lap event-time simulation
- Independent lap counts for every car
- Live standings, racer swaps, incidents, and race feed
- Persistent race results, full event archives, and replay
- Four-week, 20-race seasons with one Monday-Friday race each week
- Server-owned weekday scheduling at 8:00 PM Eastern, including automatic race starts and finishes
- A different track for each five-race week
- Team championship points across the full season
- Relay-plan editing whenever no league race is active
- Accelerated playback for development and testing

League plans, rosters, transactions, development, races, and championship results are persisted in `work/asscar60.sqlite`.

## Online / Multiplayer

The server can now run as a shared online app. Manager login uses an HTTP-only session cookie, and team-specific write actions are checked against the logged-in manager's assigned team.

Useful environment variables:

- `HOST`: bind address. Defaults to `0.0.0.0` for deployment.
- `PORT`: server port. Defaults to `4173`.
- `ASSCAR_DB_PATH`: SQLite database path. Defaults locally to `work/asscar60.sqlite`; use a persistent disk online.

Stewards controls are only visible and usable when logged in as the reserved `devman` account.

Docker example:

```powershell
docker build -t asscar60 .
docker run --rm -p 4173:4173 -v asscar60-data:/data asscar60
```

For online hosting, put the app behind HTTPS and make sure `/data` or the configured `ASSCAR_DB_PATH` is persistent so seasons, accounts, drafts, and archives survive restarts.

## Railway

Railway can deploy this app directly from the included `Dockerfile` and `railway.json`.

1. Create a Railway project from the GitHub repo.
2. Add a persistent volume mounted at `/data`.
3. Set `ASSCAR_DB_PATH=/data/asscar60.sqlite`.
4. Let Railway provide `PORT`; the server reads it automatically.
5. Deploy, then use the generated Railway URL for manager registration.
