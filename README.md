# WoW Admin – AzerothCore Admin Tool

A server administration tool (Electron + Node.js + TypeScript) for an
[AzerothCore](https://www.azerothcore.org/) World of Warcraft server, using
SOAP and direct database access. The same UI can run as a **native Node.js web
service** in the browser (the primary, fully tested route) or as an Electron
desktop app.

> This repository is a fork of
> [scarecr0w12/wowmin](https://github.com/scarecr0w12/wowmin) ("WoW Admin",
> v2.4.3 and earlier), by **Jellypowered**. Version 3.0.0 starts a
> new release line for this fork, focused on live worldserver telemetry,
> instance/battleground observation, and session recording. See
> [CHANGELOG.md](CHANGELOG.md).

## Features

### SOAP Console
- Connect to any AzerothCore worldserver with SOAP enabled
- Execute any server console command remotely
- Quick-command sidebar for common operations
- Command history (↑ / ↓ arrow keys)
- Color-coded success/error responses

### Database Editor 
- **SQL Query Editor** - Execute raw SQL queries with syntax highlighting
- **Table Browser** - View and edit any table in the database
- **Keira-style Entity Workspace** - A dedicated editor column, generated SQL panel, and side rail for live preview + related data
- **Entity Editors** - Specialized editors for:
  - Creatures (`creature_template`)
  - Items (`item_template`)
  - Quests (`quest_template`)
  - Spells (`spell_dbc`)
  - Game Objects (`gameobject_template`)
  - NPC Vendors (`npc_vendor`)
  - Loot Tables (`creature_loot_template`)
  - SmartAI Scripts (`smart_scripts`)
- **Live Preview Rail** - Quality-coloured preview cards, summary stats, quick lookup links, and in-app visual reference media for supported entities
- **Related Data Rail** - View vendor, loot, and quest-adjacent rows from the current entity and jump directly into those records
- **Smart Selectors** - Search-and-apply pickers for common creature/item/quest reference fields
- **Connection Profiles** - Save and switch between multiple database connections
- **Query History** - Track and re-run previous queries
- **Export to CSV** - Export query results to clipboard

### Live Map (Enhanced in 3.0.0)
- Real-time canvas map showing all online player positions
- **Live worldserver telemetry**: with the companion
  [`mod-wowmin-telemetry`](https://github.com/Jellypowered/mod-wowmin-telemetry) module
  installed, player positions, health/power, target, and combat state come
  straight from the worldserver every second instead of stale database saves;
  the characters database is used only as a fallback
- Continent switcher: Eastern Kingdoms, Kalimdor, Outland, Northrend
- Map backgrounds preserve their aspect ratio automatically to avoid stretching/deformation on resize
- Player dots colour-coded by WoW class; bot accounts dimmed; movement is interpolated so dots glide between telemetry polls
- **Click a dot or sidebar row to select a player** — shows name, level, race, class, and live coordinates without disturbing the camera, pan, or zoom
- Quick SOAP actions from the selection panel: Info, Freeze, Unfreeze, Summon, Kick, Ban
- Hover tooltip with player details
- Zoom controls with mouse wheel zoom, double-click zoom, drag-to-pan while zoomed, and quick reset back to `100%`
- Auto-refresh (1 s) with manual refresh; filter by real players, bots, or all, with bot detection resolved from account usernames when available
- Optional map image backgrounds: place `0.jpg`, `1.jpg`, `530.jpg`, `571.jpg` in `assets/maps/` (see `assets/maps/README.txt`)
- Shared race/gender portraits, class icons, and compact flag-carrier, taxi,
  mounted, combat, sap, stun, death, spirit-form, and resurrection indicators across Players,
  Live Map, and Instance Watch. Extracted client artwork is optional; generic
  emoji are used automatically when it is absent
- Requires a separate database connection to `acore_characters` unless live telemetry is active

### Instance / Battleground Watch (New in 3.0.0)
- Dedicated **Instance Watch** tab that discovers every active runtime instance,
  raid, battleground, and arena on the server, grouped by runtime instance ID
- Client artwork backgrounds for instances, raids, battlegrounds, and arenas
  extracted from the WoW client (including per-floor dungeon artwork for
  multi-floor instances), with stable projection bounds and letterboxing
- Live participant markers with faction colors, health bars, movement trails,
  headings, and combat indicators
- Group/raid membership, subgroup, faction/team, core LFG role, and runtime
  session age per participant
- Battleground match state: phase, team scores, alive counts, decoded
  objectives (scores, captures, timers, flag state), and resurrection state;
  the active server-selected bot strategy is shown read-only when available
- Encounter state: boss state tracking and per-session death history
- Pan, anchored zoom, participant focus, and Fit view with per-session
  viewport persistence, so the view stays stable across polling
- Floor-aware dungeons: participants are classified onto the correct dungeon
  floor from WMO/height context and only that floor's markers and trails are
  shown

### Session History & Replay (New in 3.0.0)
- Completed instance, raid, battleground, and arena runs are recorded
  automatically to JSON files: participants, timestamped discrete events
  (kills, deaths, loot, level-ups, objective and flag transitions), running
  totals, and sampled movement routes
- Server-owned event IDs make kills, loot, and level-ups exact despite the
  1 s telemetry poll; routes sample every 5 s by default
- **Session history** tab with a browsable index, embedded replay panel, and
  playback controls (play, pause, stop, seek, and 0.5×–16× speed)
- Completed battlegrounds show the winning faction directly in the history
  list and replay header. Warsong Gulch shows its flag score, Eye of the Storm
  shows resource points, and other battlegrounds show the winner without a
  misleading generic scoreline
- Replay renders the map artwork with per-participant colored routes (broken
  across death/release/teleport jumps), a chronological event log, and running
  totals at the seek position
- Interrupted checkpoints from crashes or shutdowns are purged automatically
  at startup; completed history is only ever removed by the explicit
  **Purge all** button

### Live telemetry – `mod-wowmin-telemetry`
- Live position/state telemetry is produced by the standalone companion module
  **`mod-wowmin-telemetry`** (a separate AzerothCore module that is not
  included in this repository). Install it into
  `azerothcore-wotlk/modules/mod-wowmin-telemetry`, build, and start the
  worldserver as usual (see below)
- It publishes a versioned `WMAP` protocol (v1–v7) via an administrator-only
  `wowmin telemetry [mapId] [instanceId]` SOAP command; older module versions
  are still parsed by this client for backward compatibility
- The module is independent of `mod-playerbots` (playerbot details are an
  optional, compile-time extension) and shares a single 1 s poll across the
  Live Map, Instance Watch, and session recorder, configurable via
  `WOWMIN_TELEMETRY_POLL_MS` (default 1000, minimum 500)

### Economy Monitor
- Dedicated **Economy** tab for monitoring the live in-game auction house and character wealth
- Search active auction-house listings by item name, item entry, or owner name
- View per-item market averages including listing count, total quantity, average unit buyout, and min/max unit pricing
- Look up any character's current gold directly from the connected characters database
- Overview cards surface active auction counts, unique items listed, average buyout pricing, total realm gold, and the richest tracked character
- Uses the connected `acore_characters` database for auction and gold data, plus the matching world database name for item names and quality metadata

### Remote Log Monitor
- Connect to a remote AzerothCore host over SSH/SFTP
- Scan `worldserver.conf` to discover configured `Logger.*` and `Appender.*` definitions
- Resolve `LogsDir`, packet log paths, file-based appender targets, and dynamic `%s` log patterns
- Pick a logger first, then choose from the live readable files currently associated with that logger for a much cleaner in-app tail workflow
- Flag unreadable configured targets and preview the latest log output directly in-app
- Optional live follow mode refreshes the selected log preview every few seconds for a lightweight `tail -f` workflow
- Save remote log connection details and follow-mode settings as part of an existing connection profile
- Works with password-based SSH/SFTP access today

### App Updates
- Electron desktop builds automatically check GitHub releases on startup for
  newer app versions; the header status indicator shows current version, update
  availability, or check errors
- Manual **Check** button to refresh release status on demand; the **Open
  Release** button opens the latest GitHub release page in the default browser
  when an update is available
- The native web service skips upstream release checks by default
  (`WOWMIN_WEB_MODE=1`)

### Dashboard
- Server info at a glance (uptime, online players, peak)
- Quick actions for common server operations
- Activity log for tracking commands

### Player Management
- View online players with filtering and search
- Player level, race, and class populated automatically on list load
- Player details and moderation actions
- Kick, ban, mute, freeze, and more

### GM Tickets
- Dedicated **Tickets** tab for open, online, closed, and escalated GM tickets
- Ticket list parsing understands AzerothCore's colorized GM-ticket output and fills the player, created, and last-updated columns directly from the server response
- Selecting a ticket opens a structured detail panel with the ticket message, comment, and response when available
- Quick ticket actions for assign, unassign, comment, close, delete, escalate, and response management
- Optional auto-refresh keeps the queue current while connected

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** ≥ 18 | https://nodejs.org |
| **AzerothCore worldserver** | SOAP must be enabled (see below) |
| **MySQL/MariaDB** | For database editing features |
| **`mod-wowmin-telemetry`** | Optional but strongly recommended for live map/instance telemetry (see below) |
| **WoW 3.3.5a client files** | Only if you want map background artwork extracted locally |

### Live telemetry – `mod-wowmin-telemetry`

Live player positions, combat state, instance/battleground state, and session
recording all come from the standalone **`mod-wowmin-telemetry`** AzerothCore
module, which is a separate project and is not bundled in this repository.
Install it into
your AzerothCore source tree:

```bash
# clone the module into your AzerothCore source tree, e.g.
cd azerothcore-wotlk/modules
git clone https://github.com/Jellypowered/mod-wowmin-telemetry.git
# then rebuild and restart the worldserver
```

Once it is running, the module registers the administrator-only SOAP command:

```
wowmin telemetry [mapId] [instanceId]
```

No worldserver configuration changes are required. Without the module, the
Live Map falls back to saved database positions (stale between character
saves) and the Instance Watch / Session History tabs have no live data.

### Enable SOAP on your worldserver

In your `worldserver.conf`, set:

```ini
SOAP.Enabled  = 1
SOAP.IP       = "127.0.0.1"
SOAP.Port     = 7878
```

You also need an account with security level **3** (or higher) to
authenticate. You can set this in the `account` table or with:

```
.account set sec <account> 3
```

### Database Access

For database editing features, you need MySQL/MariaDB credentials with read/write
access to your AzerothCore databases:

- `acore_world` - World database (creatures, items, quests, etc.)
- `acore_auth` - Auth database (accounts, permissions)
- `acore_characters` - Characters database (player data)

The **Economy** tab uses the `acore_characters` database for auction-house and character-money data, and derives the matching world database name (for example `acore_world`) to resolve item names and quality.

## Getting Started

```bash
# Install dependencies
npm install

# Build TypeScript and Tailwind CSS
npm run build:ts
npm run build:css

# Run the test suite (no server or client required)
npm test

# Or build everything and start the desktop app
npm start
```

> **Testing note:** the browser-based web service is the route that has been
> fully exercised in practice. The Electron desktop build should work
> identically (it shares the same main-process and renderer code), but it has
> not been validated end-to-end on every platform; report issues if you rely
> on it.

## Native Web Service

The same UI can run in a browser without Docker or a graphical desktop. Build it,
set HTTP Basic Authentication credentials, and start the Node.js service:

```bash
npm ci
npm run build:ts
npm run build:css

export WOWMIN_HOST=0.0.0.0
export WOWMIN_PORT=3000
export WOWMIN_USERNAME=admin
export WOWMIN_PASSWORD='replace-with-a-strong-password'
export WOWMIN_DATA_DIR="$PWD/.wowmin-data"
npm run start:web
```

Open `http://server-address:3000/` and sign in with the configured HTTP
credentials. The browser UI keeps the desktop app's SOAP, database, map,
economy, inventory, profile, and remote-log APIs. Because those APIs include raw
SQL and server administration commands, do not expose the service without
authentication; use a TLS reverse proxy when access crosses an untrusted
network.

A hardened systemd unit template is provided at `deploy/wowmin.service.example` (copy it to
`/etc/systemd/system/wowmin.service`, adjust the install path, and
`systemctl daemon-reload`). It
expects `/etc/wowmin.env` to define the variables above and stores profiles in
`/var/lib/wowmin` when `WOWMIN_DATA_DIR=/var/lib/wowmin` is set. Set
`WOWMIN_WEB_MODE=1` to disable upstream GitHub release checks in the service.

For server-managed connections, set all three of `WOWMIN_SOAP_USERNAME`,
`WOWMIN_SOAP_PASSWORD`, and `WOWMIN_DB_PASSWORD` in the environment. The browser
then auto-connects SOAP, world DB, characters map DB and economy DB after HTTP
login, hides the corresponding credential forms, disables saved profiles in
web mode, and reads logs locally rather than requiring SSH credentials. The
remaining settings are:

```ini
WOWMIN_SOAP_HOST=127.0.0.1
WOWMIN_SOAP_PORT=7878
WOWMIN_DB_HOST=127.0.0.1
WOWMIN_DB_PORT=3306
WOWMIN_DB_USERNAME=acore
WOWMIN_WORLD_DB=acore_world
WOWMIN_CHARACTERS_DB=acore_characters
WOWMIN_WORLD_CONFIG=/path/to/azerothcore/env/dist/etc/worldserver.conf
WOWMIN_LOG_DIR=/path/to/azerothcore/env/dist/bin
```

Live telemetry and session recording settings (all optional):

```ini
# Shared poll interval for Live Map, Instance Watch, and session recording (ms, min 500)
WOWMIN_TELEMETRY_POLL_MS=1000
# How often movement routes are sampled into session records (ms)
WOWMIN_SESSION_ROUTE_INTERVAL_MS=5000
# How long a vanished session must stay absent before it is finalized (ms)
WOWMIN_SESSION_COMPLETION_GRACE_MS=15000
```

Completed session records use readable names such as `WSG-3-Oct08-26.json` and are kept indefinitely
under `$WOWMIN_DATA_DIR/sessions/`; only the explicit **Purge all** button in the
Session history tab deletes them. Abandoned checkpoints from crashes are
removed automatically at startup.

Keep `/etc/wowmin.env` mode `0600` and restart the service after edits. Web
mode disables upstream release checks; the Electron desktop build retains them.

## Docker

The web service ships as a container image. The image is built from the same
`dist/web-server.js` web mode described above (no Electron at runtime), runs as
the non-root `node` user (UID 1000), and exits cleanly on SIGTERM.

### Build locally

```bash
docker build -t wowmin .
```

### Run

```bash
docker run -d --name wowmin \
  -p 3000:3000 \
  -e WOWMIN_USERNAME=admin \
  -e WOWMIN_PASSWORD='replace-with-a-strong-password' \
  -v wowmin-data:/data \
  wowmin
```

Open `http://server-address:3000/` and sign in with the HTTP credentials. The
container honours every `WOWMIN_*` variable documented in
[Native Web Service](#native-web-service) (SOAP and database hosts, managed
mode, telemetry, session recording), e.g. add
`-e WOWMIN_SOAP_HOST=... -e WOWMIN_DB_HOST=...` for server-managed
connections. `WOWMIN_DATA_DIR` is preset to `/data`; mount a volume there to
keep profiles and session recordings across restarts.

The same warning applies: the UI exposes raw SQL and server administration
commands. Always set `WOWMIN_USERNAME`/`WOWMIN_PASSWORD` and put a TLS reverse
proxy in front when the port is reachable from an untrusted network.

### Prebuilt images (GHCR)

Pushing a tag `vX.Y.Z` triggers
[`.github/workflows/docker-publish.yaml`](.github/workflows/docker-publish.yaml):
a secrets scan, an image smoke test (auth enforced, assets served, graceful
shutdown), then a build pushed to `ghcr.io/griznah/wowmin`, tagged `X.Y.Z`,
`X.Y` (latest minor line) and `latest`.

```bash
docker run -d --name wowmin \
  -p 3000:3000 \
  -e WOWMIN_USERNAME=admin -e WOWMIN_PASSWORD='...' \
  -v wowmin-data:/data \
  ghcr.io/griznah/wowmin:latest
```

> The workflow flips the package public automatically after each push
> (GHCR creates new packages private). To pull an older private fork image
> instead, authenticate first (`docker login ghcr.io -u <github-user>` with a
> PAT that has `read:packages`).

## Usage

### SOAP Connection
1. Enter the **Host**, **Port**, **Username**, and **Password** in the
   connection bar.
2. Click **Connect** — the app will run `server info` to verify the connection.
3. Type commands in the console input or use the **Quick Commands** sidebar.
4. Press **Enter** or click **Send** to execute.

### Database Connection
1. Navigate to the **Database** tab.
2. Select the database type (World, Auth, or Characters).
3. Enter your MySQL connection details.
4. Click **Connect** to establish the database connection.
5. Use the table browser to explore tables, or use the SQL editor for queries.
6. Open the **Entity Editor** when you want a richer Keira-style workflow for template records instead of raw rows.

### Entity Editor
1. In the Database tab, switch to the **Entity Editor** subtab.
2. Select an entity type (Creature, Item, Quest, etc.).
3. Enter the entry/ID and click **Load**.
4. Use the form editor for field groups, the generated SQL panel for diff/full query review, and the right-side preview rail for quick validation.
5. Use selector buttons on supported reference fields to search for linked items, creatures, or quests without leaving the editor.
6. Review the **Related Data** panel to inspect nearby vendor/loot/reward rows and jump directly into linked records.
7. Edit fields and click **Save** to commit changes.

#### Entity Editor highlights

- **Live Preview** updates while you edit, including item quality colouring and richer item/creature/quest summary cards
- **Visual Reference Media** is fetched into the preview rail for supported entities so you can sanity-check what you loaded without leaving the app
- **Related Data** helps you move through connected rows faster when working on loot, vendors, or quest rewards
- **Quick links** let you open external references such as Wowhead in your default browser when deeper research is needed

### Live Map
1. Navigate to the **Live Map** tab.
2. If `mod-wowmin-telemetry` is running on the connected worldserver, positions come live automatically. Otherwise enter the `acore_characters` MySQL connection details in the map connection bar and click **Connect** (saved, between-saves positions).
3. Players on the selected continent appear as coloured dots (class colours) on the canvas.
4. Use the continent buttons to switch between Eastern Kingdoms, Kalimdor, Outland, and Northrend.
5. **Click a dot** or a row in the sidebar to select a player — a panel appears with their details and quick action buttons (Info, Freeze, Unfreeze, Summon, Kick, Ban). Actions are sent via the active SOAP connection. Selecting a player does not move the camera, pan, or zoom.
6. Use the mouse wheel or **double-click** to zoom into the map; drag to pan while zoomed, or click the zoom percentage control to reset to `100%`.
7. Optionally place map image files (`0.jpg`, `1.jpg`, `530.jpg`, `571.jpg`) in `assets/maps/` for visual map backgrounds (see `assets/maps/README.txt`). The app preserves the image aspect ratio automatically.
8. To generate those from a WoW 3.3.5a client, run `npm run extract:maps -- --source /path/to/WoW` (or the npm shorthand `npm run extract:maps --source /path/to/WoW`) or point it at an extracted `World/Minimaps` folder.
9. Optionally extract race/gender portraits, class icons, and player-state icons with `npm run extract:icons -- --source /path/to/WoW`. If skipped, WoWMin uses emoji fallbacks.

### Instance / Battleground Watch
1. Navigate to the **Instance Watch** tab (keyboard shortcut **Alt+7**). Active runtime instances, raids, battlegrounds, and arenas are discovered automatically and appear as cards in the sidebar; nothing to configure beyond a SOAP connection.
2. Switch the **Session** dropdown to inspect another session; **Auto (1 s)** keeps the selected session fresh, with a full re-discovery every 10 s.
3. The map pane uses extracted client artwork when available (with per-floor dungeon artwork for multi-floor dungeons), otherwise calibrated or auto-fit bounds.
4. **Click a participant marker or sidebar row** to focus the view on them; **Fit** restores a view that fits everyone, **−**/**+** zoom around the cursor, and **Clear focus** releases the focused participant.
5. Battlegrounds additionally show the match phase, team scores, alive counts, decoded objectives, resurrection state, and the server-selected bot strategy (read-only).
6. The encounter card lists boss states and the session death history; the participant list shows faction, group/subgroup, LFG role, health and power, and target.

### Session history & replay
1. Navigate to the **Session history** tab (keyboard shortcut **Alt+8**). Completed runs from `$WOWMIN_DATA_DIR/sessions/` are loaded at startup and remain available without a SOAP, worldserver, or database connection.
2. **Click a record** to load it into the embedded replay panel.
3. Use **Play**, **Pause**, **Stop**, the seek slider, and the speed selector (0.5×–16×) to scrub through the run. Routes are drawn incrementally per participant, the event log follows the playhead, and the running totals reflect the seek position.
4. **Purge all** permanently deletes every completed session record after a confirmation prompt; it does not affect in-progress recordings. Abandoned checkpoints are already removed automatically at startup.

> **Replay fidelity:** server-reported events (kills, loot, level-ups) are exact. Objective and flag transitions derived from telemetry snapshots reflect poll timing, and routes are sampled (default every 5 s), so movement between samples is interpolated rather than recorded.

### Remote Log Monitor
1. Navigate to the **Logs** tab.
2. Enter the remote SSH host, port, username, password, and the remote `worldserver.conf` path.
3. Click **Scan Remote Logs** to inspect `LogsDir`, appenders, loggers, packet log settings, and readable files.
4. Review the summary cards and warnings to spot unreadable configured paths, missing dynamic log matches, or directory access issues.
5. Use the **Logger** picker to choose the subsystem you want to inspect, then choose one of its currently available **Live File** entries.
6. Review the file details panel to confirm the resolved path, timestamp, size, and matched appender hints before loading the preview.
7. Enable **Live follow** if you want the preview to auto-refresh like a lightweight in-app `tail -f`, then choose the refresh interval that fits your server.
8. Save the connection profile if you want those remote log settings remembered alongside your SOAP/database details.

### Economy Monitor
1. Navigate to the **Economy** tab.
2. Enter the `acore_characters` MySQL connection details and click **Connect**.
3. Review the overview cards to see active auctions, unique listed items, average buyout values, and total character gold.
4. Use the search field to find auction-house rows by item name, numeric item entry, or owner name.
5. Review **Average Market Values** for quick per-item pricing averages and **Auction House Listings** for the live individual rows behind that market.
6. Use **Character Gold Lookup** to inspect the money held by a specific character.

### GM Tickets
1. Navigate to the **Tickets** tab while connected to SOAP.
2. Use the filter buttons to switch between **Open**, **Online**, **Closed**, and **Escalated** ticket queues.
3. Click a ticket row to open the detail panel and review the player, created age, last change, and ticket message.
4. Use the inline row buttons or the forms below the table to assign, comment, escalate, close, delete, or manage ticket responses.
5. Enable **Auto (30s)** if you want the ticket queue to refresh periodically while connected.

#### Economy monitor notes

- Auction data comes from the AzerothCore `auctionhouse` and `item_instance` tables in the connected characters database.
- Item names and quality colours are resolved from the matching world database's `item_template` table.
- Search supports both fuzzy text matching and direct numeric item-entry lookup.

#### Remote log monitor notes

- The current remote log workflow uses **username/password SSH/SFTP authentication**.
- The app reads `worldserver.conf` remotely and infers log file locations from `LogsDir`, `Appender.*`, and `PacketLogFile`.
- Dynamic file appenders such as `gm_%s.log` are matched against the current contents of the resolved logs directory.
- Logger-to-file matching is resolved in-app, so the live file picker only shows files currently associated with the selected logger instead of every readable file in the logs directory.
- Live follow pauses automatically when you leave the **Logs** tab, so it does not keep polling in the background unnecessarily.

### App Updates
1. Launch the app normally.
2. The header automatically checks GitHub for the latest release and shows your current version.
3. If a newer release exists, the banner changes state and exposes an **Open Release** button.
4. Use **Check** any time to manually refresh the release status.

### Extracting player and state icons

WoWMin can use the race/gender portraits, class atlas, and state/spell icons
from your own WoW 3.3.5a client:

```bash
npm run extract:icons -- --source "/path/to/WoW 3.3.5a"
```

The command reads MPQ patches in client precedence order and writes local PNGs
plus `assets/player-icons/index.json`. These derived files are gitignored and
are not distributed with WoWMin. Without the index—or when older telemetry does
not provide state fields—the interface uses generic emoji. Older telemetry
without gender uses the extracted male race portrait until v6 is deployed.
Lists stack up to three states by priority; map markers show only the
highest-priority state so simultaneous effects remain readable. Live Map and
Instance Watch provide synchronized, persisted 75–250% icon-size controls;
canvas icons also grow progressively as the map is zoomed.

### Extracting map backgrounds from the WoW client

You can now generate the live-map backgrounds directly from WoW minimap tiles:

```bash
# From a WoW 3.3.5a client root (the extractor now reads WoW MPQs directly; external tools are only a fallback)
npm run extract:maps -- --source "/path/to/WoW 3.3.5a"

# npm shorthand also works
npm run extract:maps --source "/path/to/WoW 3.3.5a"

# Or from an already extracted World/Minimaps directory
npm run extract:maps -- --source "/path/to/World/Minimaps"
```

The extractor stitches the continent tiles and writes these files into `assets/maps/`:

- `0.jpg` — Eastern Kingdoms
- `1.jpg` — Kalimdor
- `530.jpg` — Outland
- `571.jpg` — Northrend

To regenerate only Outland/map 530 without touching the other continents:

```bash
npm run extract:maps -- --source "/path/to/WoW" --map 530 --output ./assets/maps
```

Map 530 includes detached starting-zone islands. Some client `common.MPQ`
textures contain opaque white/grey padding around their edges; the extractor
removes those pixels only for exact audited source texture hashes on map 530.
It preserves real water pixels, image dimensions, and tile-coordinate bounds.
Different replacement textures and artwork on other maps are not filtered.

Useful flags:

- `--output /custom/dir` to write somewhere else
- `--quality 95` to tweak JPEG quality
- `--keep-workspace` to keep the raw extracted minimap tiles
- `--workspace ./tmp/minimaps` to control where temporary extraction files go

On Linux, note that some patch MPQs may be malformed or some minimap tiles may be corrupt in patched clients. The extractor now skips unreadable archives/tiles when possible and continues building the continent JPGs. If built-in extraction still cannot resolve your client, `7zz` remains a useful fallback, or you can extract `World/Minimaps` manually and point `--source` there.

### Extracting instance, raid, battleground, and arena artwork

The same extractor produces the artwork used by the Instance Watch tab:

```bash
# One map
npm run extract:maps --source "/path/to/WoW" --map 489

# Every instance, raid, battleground, and arena (recommended once)
npm run extract:maps --source "/path/to/WoW" --all-instances
```

#### Classic/TBC dungeon artwork with WDM patches

For proper classic/TBC dungeon floor plans rather than stitched exterior
minimaps, install the optional [WDM client patches](https://github.com/Trimitor/WDM-patch)
into your own client's `Data/<locale>/` before extracting:

- `patch-<locale>-M.MPQ`: dungeon artwork, floor-coordinate bounds, and
  WMO-group/Z floor membership tables.
- `patch-<locale>-N.MPQ`: optional outdoor caves/entrances and area overrides;
  the patch author requires M plus the WDM/Astrolabe addons for these in-game maps.

Then run the same `--all-instances` command above. The extractor loads lettered
patches after numbered patches (N after M), uses `WorldMapArea.dbc` directory
aliases to find the artwork, and reads the patched `DungeonMap.dbc` and
`DungeonMapChunk.dbc` tables. WoWMin uses those bounds and its existing telemetry
WMO-group/Z floor selector; it does **not** run or require addon Lua at runtime.

WDM supplies in-game navigation/UI for the optional microdungeons, while
Astrolabe supplies marker-position translation. Those outdoor microdungeon
menus and the client's native fallback/transform rules are not fully reproduced
by WoWMin's instance viewer. Individual floor transitions still need in-game
comparison; having the artwork does not by itself prove exact client parity.

Patch artwork remains locally extracted, not bundled in this repository.

Outputs go to `assets/instances/` (`<mapId>.jpg`, per-floor
`<mapId>-floor-<n>.jpg`, plus JSON metadata and an `index.json`). These
artifacts are **not committed** to this repository (they are large and derived
from the client), so run the extractor once on your own machine. Maps without
directly extractable artwork fall back to calibrated or auto-fit bounds and a
plain background.

## Project Structure

```
wow-admin/
├── package.json
├── tsconfig.json           # TypeScript configuration
├── tailwind.config.js      # Tailwind CSS configuration
├── esbuild.config.js       # Build configuration
├── src/
│   ├── main.ts             # Electron main process (shared with web mode)
│   ├── preload.ts          # Context bridge (IPC)
│   ├── web-server.ts       # Native web service entry point (npm run start:web)
│   ├── web-electron-shim.ts# Exposes the IPC surface to browser tabs
│   ├── soap-client.ts      # SOAP/HTTP client for AzerothCore
│   ├── live-map-telemetry.ts # WMAP protocol (v1–v7) parser + command builder
│   ├── session-recorder.ts # Session recording, persistence, index, purge
│   ├── local-logs.ts       # Local (non-SSH) log discovery for web mode
│   ├── config-store.ts     # Profile persistence
│   ├── database/
│   │   └── db-service.ts   # MySQL database service
│   └── types/
│       └── electron.ts     # TypeScript type definitions
├── renderer/
│   ├── index.html          # App UI
│   ├── styles.css          # Base styling
│   ├── styles/
│   │   ├── tailwind.css    # Tailwind input
│   │   └── output.css      # Generated CSS
│   └── scripts/
│       ├── app.ts          # Main frontend logic (SOAP, DB, map, instances, replay)
│       ├── web-api.ts      # Browser fetch implementation of the IPC surface
│       ├── types/
│       │   └── state.ts    # Application state types
│       └── utils/
│           ├── helpers.ts  # Utility functions
│           ├── map-coords.ts # WoW coordinate conversion utilities
│           ├── instance-watch.ts # Instance grouping, floors, bounds, projection
│           ├── session-replay.ts # Replay route/event/total math
│           ├── player-icons.ts # Shared extracted-icon and emoji fallback logic
│           └── online-players.ts # Online-player parsing helpers
├── assets/
│   ├── maps/               # Optional continent map backgrounds (0.jpg, 1.jpg, 530.jpg, 571.jpg)
│   ├── instances/          # Optional instance/raid/BG/arena artwork (extracted locally)
│   └── player-icons/       # Optional client portraits/class/state icons (extracted locally)
├── scripts/
│   ├── extract-map-assets.mjs # WoW minimap/worldmap/dungeon-floor extractor
│   ├── extract-player-icons.mjs # WoW portrait/class/state icon extractor
│   └── test-*.cjs          # Self-contained test suites (npm test)
├── deploy/
│   └── wowmin.service.example # Hardened systemd unit template
└── dist/                   # Compiled output
```

## Testing

The repository ships a self-contained test suite that needs no worldserver,
client, or database:

```bash
npm test          # runs all scripts/test-*.cjs with node:test
npm run typecheck # tsc --noEmit over the whole project
```

Coverage includes the telemetry protocol parser (versions 1–5, rejection of
truncated/unknown snapshots), command building, session grouping and
battleground decoding, map projection math (continents, calibrated
battlegrounds, minimap tiles, dungeon floors, pan/zoom/fit), the session
recorder (persistence, deduplication, checkpoint purge, explicit history
purge), and replay route/event math.

## Development

```bash
# Type checking
npm run typecheck

# Build TypeScript (watch mode)
npm run build:ts:watch

# Build Tailwind CSS (watch mode)
npm run build:css:watch

# Development mode (Electron)
npm run dev
```

## Building for Distribution

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
npm run build:all    # Windows + Linux
```

On Windows, the packaging commands intentionally run through `scripts/package.js`,
which disables Electron Builder's `signAndEditExecutable` step so non-elevated
shells and CI jobs can still produce the NSIS/portable installers.

## Technology Stack

- **Electron** - Cross-platform desktop application
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS framework
- **mysql2** - MySQL client with Promise support
- **esbuild** - Fast TypeScript bundler

## Inspiration

This project was inspired by [Keira3](https://github.com/azerothcore/Keira3),
an excellent database editor for AzerothCore. WoW Admin combines similar database
editing capabilities with SOAP console functionality for a complete server
administration toolkit.

## License

MIT
