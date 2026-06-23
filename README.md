# WiDash

A local RMA dashboard for datacenter engineers. Reads cases from a
GUS report, talks to Coolan for component health, walks the
master-patchplan to surface cable connections, joins mom.dmz topology
with Argus time-series for live rack temperatures, and lets you read +
write Salesforce cases, chatter, and case fields without leaving the
tab.

Frankfurt is the only region pre-registered today; the multi-region
plumbing is in place so adding Paris / Amsterdam / Tokyo / … is one
line in `SITE_REPORTS` once their report ids are known. Each user
picks their region in the in-app settings modal, or WiDash
auto-detects it from recent SF activity.

## Prerequisites

Three local tools — install once per machine:

- **Salesforce CLI** (`sf`) — https://developer.salesforce.com/tools/salesforcecli
- **Python 3.11** — `brew install python@3.11`
- **Bun** — auto-installed by `install.sh` on first run if missing

## Setup

```bash
git clone https://github.com/nelamin-ops/widash-releases.git widash
cd widash
./install.sh        # backend venv + frontend deps + chromium for Coolan auto-auth
sf org login web    # opens browser for SF login
./start.sh          # starts backend + frontend, opens http://localhost:5173
```

`./install.sh` is idempotent — re-run it after a `git pull` and it
just refreshes deps. `./start.sh` kills any stale uvicorn / vite from
a previous run before booting fresh ones. To shut WiDash down later,
run `./stop.sh` — it frees ports 8000 and 5173 and is safe to run
when nothing is up.

On first launch the **Region settings** modal opens automatically.
WiDash auto-detects your region from your last 90 days of edited
cases and pre-fills the suggestion. Confirm with one click, or paste
a custom report id. Coolan, mom.dmz, and the master patchplan are
optional data sources — they activate themselves once you connect
them via the corresponding pills in the header (or, for the
patchplan, drop CSVs into `~/.widash/patchplan/`).

## Updating

If the dashboard shows the yellow update banner:

```bash
cd ~/path/to/widash
./update.sh         # git pull + refresh deps
./start.sh
```

## Optional data sources

The core dashboard works with just the sf-CLI. The pills in the
header light up the optional integrations:

### Master patchplan (🔌 bubble bottom-right)

If your site maintains a master-patchplan Google Sheet, drop CSV
exports into `~/.widash/patchplan/` and click **Refresh** in the
explorer. Without CSVs the bubble shows a setup hint instead of an
empty tree — feature is fully opt-in. Files stay local; nothing is
uploaded.

### mom.dmz live temperatures (🌡 pill in the header)

Click the 🌡 pill — the modal walks you through pasting a Cookie
header from `mom.dmz.salesforce.com/mom/datacenter-temperature`
(DevTools → Network → any request → copy `Cookie`). Saved to
`~/.widash/mom_auth.json` (chmod 600). Re-paste when the cookie
expires (pill turns red).

### Coolan component health (❄ pill in the header)

Click the ❄ pill, then **Open browser window** for the first run
(MFA happens in a visible Chromium window). Subsequent reauths use
**Auto-connect (headless)**. Manual `Bearer …` paste is the
fallback if both fail. Token is saved to
`~/.widash/coolan_auth.json` (chmod 600).

### Add a new region

Send Najih the GUS RMA report id for your DC; one line goes into
`SITE_REPORTS` in `backend/gus_client.py` and the next release
makes the region available to everyone. Until then, paste the
report id directly in the Region settings modal — works
immediately but is per-user, not shared.

## Tests

```bash
cd backend && source .venv/bin/activate && pytest        # backend
cd frontend && bun run test                              # frontend
```

## Features

### Dashboard
- **Donut chart** of active RMAs grouped by status, with priority
  breakdown per status. Click a segment to expand the ticket list.
- **Legend card**: total, RTS today, my RTS still open, my RTS closed
  (180-day window).
- **Activity log**: last 200 status-change + comment events on the
  in-scope cases. Filters by Status, by Comments, by **Me**
  (auto-derived from your SF session), by status pills, free-text
  comment search, and ticket-id search. Bot toggle hides
  service-account noise. Column visibility + order is persistent per
  browser via the gear icon. Outside-hours events (⏰) are scored
  in the *site's* timezone, not the engineer's, so a 14:00 JST
  event in a Tokyo case stays in-hours when a Frankfurt user
  reviews it overnight.
- **Background polling**: dashboard auto-refreshes every 15s so
  status changes from colleagues / GUS itself propagate without a
  manual reload. Pauses when the tab is hidden.
- **Update banner**: yellow banner appears at the top of the
  dashboard when a newer release is on `widash-releases`. Shows
  current + latest version + a Release Notes link. Run
  `./update.sh` to take the new version.

### Case sheet
Bottom sheet that opens when you click a ticket. Up to one open at a
time; the others minimise into a draggable tab bar (horizontal
scroll, optional pin to dock above the open sheet).

- **Header**: case number · asset path with U-position
  (e.g. `FRA3-14.1-124-E04-HU14`) · status pill (clickable, dropdown of
  the 11 RMA statuses) · Coolan reporting state · Case category /
  subcategory (cascading) / resolution picker pills · live `LIVE`
  badge when the latest detail is in.
- **Body sections** read from `/api/case/{id}`: Identification,
  Responsible parties (case owner, team, ICO/IDO, …), Datacenter &
  routing, Classification, Workflow, Times. Plus the full asset
  record. Per-section edit mode → diff confirm modal → write through
  guarded by the global ✎ **Writes-mode pill** in the header
  (default off, turns red when armed). Edit buttons are disabled
  until you flip it.
- **Coolan components** with curated attributes per asset type
  (DRIVE / MEMORY / PSU / FAN / etc.). Click a component → tooltip
  with the details (Vendor, Serial, Capacity, Slot, SMART status, …)
  scoped to the case.
- **Connections** (master patchplan): every cable with this hostname
  or rack on either side. Sortable table with side A / hops / side B,
  free-text filter, refresh button.
- **Chatter** sidebar with live FeedItem + FeedComment + CaseComment
  + EmailMessage. Avatars proxied through the backend so SF profile
  photos work in the browser. Edit-in-place for your own posts.
  Replies thread one level deep (matching GUS).
- **Polling**: case detail + chatter feed auto-refresh every 30s
  when the tab is open. Pauses while you have unsaved drafts /
  open confirm modal / in-flight save.

### Master patchplan
Floating 🔌 bubble bottom-right opens a full-screen explorer.

- Drill-down: rooms → racks → devices → cables. Cards at each level,
  cable counts shown, sticky search box that filters in place.
- Browser back / trackpad swipe-back walks one level up instead of
  leaving the page.
- Default hides rooms with <50 cable references (data-quality
  leftovers); "Show all" toggle surfaces them.
- Source: local CSV files exported from the master patchplan Google
  Sheet, dropped into `~/.widash/patchplan/`. Backend polls the
  directory every 3 minutes and only re-parses on file changes
  (mtime+size hash). To refresh: re-download tabs as CSV from
  Google Sheets. The `LocalCsvSource` is one implementation behind
  a `PatchplanSource` interface; a future Sheets-API or shared-link
  source slots in without touching the UI.
- When the directory is empty (e.g. sites without a master
  patchplan), the explorer modal shows a setup hint instead of an
  empty tree, and the Connections section in the case sheet hides
  itself.

### Rack temperatures
Floating 🌡 bubble bottom-right opens a rooms → racks → devices
overlay backed by mom.dmz internal APIs.

- **Topology** comes from `/mom/api/elasticsearch/search` (grok-device
  index, devices with `airflow-direction`); **temperatures** come from
  `/mom/api/argus/metrics/raw` time-series. Both calls share the
  Salesforce SSO cookie the user pastes via the 🌡 status pill in the
  header (saved to `~/.widash/mom_auth.json`, chmod 600).
- Rack tiles colour by max-temperature across all switches in the
  rack; click drills into the device list, click a device opens its
  history chart with hover-tooltip + timeframe / aggregation switches.
- **Coolan servers** are listed in the same rack-device view alongside
  the network switches, with a per-row source badge (MOM / Coolan).
  Coolan rows show Inlet / Exhaust / max(CPU) compactly because Coolan
  has no machine-level aggregate. The colour pill uses Inlet so the
  green→red ramp matches the switches' front sensors.
- Coolan exposes only current readings, not historical time-series, so
  clicking a server opens a snapshot panel listing every active
  TEMPERATURE_PROBE with last_report_time, plus a link to the full
  Coolan machine page — no chart.
- Live updates: 30 s for overview / rack-device list / short charts,
  120 s for 24h+ charts; pauses while the tab is hidden. Coolan
  rack-server lookups cache for 30 min (Coolan refreshes hourly).
- Inputs (site, sensor, timeframe, aggregation) are allow-listed before
  reaching Argus, and `?site=` is restricted to codes the active
  report covers so the cookie can't be pivoted to a different region.

### Settings & multi-region
- Gear icon top-left of the location pills opens the **Region
  settings** modal. Add multiple report ids to merge data across
  regions (e.g. Frankfurt + Paris); each region's site pills appear
  alongside each other in the header. Backend fans the SOQL out
  per region in parallel and merges buckets / activity events.
- Auto-detect picks your region from your recent SF activity. New
  regions get added by editing `SITE_REPORTS` in
  `backend/gus_client.py` — once a report id is registered there,
  every engineer in that region picks it up on next reload.

### AI chat sidebar
Dockable chat panel (slides in from the left, resizable via the right
edge) backed by Salesforce's internal LLM gateway. Read-only assistant —
no writes are issued, no data is sent server-side. Claude (Sonnet 4.6 /
Opus 4.7 selectable) has access to a curated tool set scoped to the
active report:

- `list_rmas` / `list_status_tickets` — count and list cases. Tickets
  carry pre-rendered `caseLink` Markdown so every cited case-number
  ends up clickable in the reply.
- `get_case` — full case detail (Identification, Workflow, asset).
  Accepts either the bare 8-digit case number OR the SF 15/18-char id;
  the bare number is what engineers actually cite.
- `recent_activity` — same activity events the dashboard shows.
- `temps_overview` / `temps_rack` — mom.dmz live temperatures.
- `coolan_components` — component health for a case.
- `patchplan_search` — cable lookup by hostname / room+rack / query.

**Rendering.** Replies are rendered as GitHub-Flavored Markdown
(`react-markdown` + `remark-gfm`): tables, lists, fenced code blocks,
inline `code`. The default `urlTransform` is overridden to allow
`widash://` alongside `http(s)://` and reject everything else, so a
prompt-injected `javascript:` / `data:` / `file:` URL can't smuggle
code in.

**Clickable in-app links.** The system prompt instructs Claude to wrap
every identifier it mentions in one of five custom URL schemes; each
parses through a strict regex before the click is dispatched to the
corresponding in-app action:

| Scheme | Action |
|---|---|
| `widash://case/<8-digit>` | opens the case sheet (active bucket → activity log → backend lookup fallback for closed / drained / RTS cases) |
| `widash://rack/<site>/<rack>` | opens the temperatures overlay focused on the rack |
| `widash://room/<site>/<room>` | opens the temperatures overlay for the site |
| `widash://hostname/<host>` | resolves the hostname via `/api/lookup/case_by_identifier` → opens the case |
| `widash://serial/<sn>` | same idea via serial number |

**Persisted conversations.** Up to 30 past conversations are kept in
`localStorage` so closing the panel (− minimise button) only hides it,
and a full page reload restores the active thread. The header shows
the title of the current conversation (derived from its first user
message), with a chevron that expands a history list — pick another
conversation, start a fresh one with **+**, or delete a single
conversation from the list. The trash icon clears only the *active*
conversation.

**Token & cost footer.** The composer footer carries a running
`Today: <tok> ($X.XX) · Month: <tok> ($X.XX)` line. Counts only the
chats run inside WiDash — DevBar's global indicator covers everything
else. Costs are computed locally with Anthropic's public pricing
(Sonnet 4.6: $3 in / $15 out per M; Opus 4.7: $15 / $75 per M; see
`PRICING` in `frontend/src/components/ChatSidebar.tsx`). The Express
LLM Gateway is a transparent passthrough, so the local figure tracks
what the engineer's SF identity gets billed.

**Error handling & retry.** Streaming failures (gateway down, stale
DevBar token, Pydantic 422 on a corrupted history) surface as an
inline red banner with the Pydantic field name when applicable. A
**↻ Retry** button re-sends the last user message after dropping
the failed turn from the conversation, so a transient failure
doesn't lose the question. Empty assistant placeholders left behind
by an aborted stream are filtered out of the history on the next
send, both client-side and server-side.

Useful for "what's the highest-priority RMA in pending drain right
now", "what's room 14.4 looking like temperature-wise", or summarising
a case's recent comments without leaving the dashboard.

### UX polish
- Light + dark theme toggle, three font-size steps, EN / DE.
- Tooltips are draggable + resizable, position persists per
  tooltip id.
- Connection retry on idle Salesforce sessions: urllib3 retry
  adapter mounted on the SF client so RemoteDisconnected on a stale
  pool connection reconnects transparently instead of surfacing as a
  500.

## Architecture

```
┌─────────────────┐     ┌────────────────────────────────┐
│  React + Vite   │ ←→  │  FastAPI                       │
│  localhost:5173 │     │  localhost:8000                │
└─────────────────┘     │                                │
                        │  GusClient ─► Salesforce       │
                        │  CoolanClient ─► Coolan        │
                        │  PatchplanSource ─► CSVs       │
                        │  MomClient ─► mom.dmz / Argus  │
                        │  ChatBackend ─► SF LLM Gateway │
                        └────────────────────────────────┘
```

- **Auth**: SF session comes from the local sf-CLI; Coolan and
  mom.dmz auth live under `~/.widash/*.json` (chmod 600). Nothing
  is stored server-side.
- **Per-report clients**: a separate `GusClient` instance per report
  id keeps caches isolated. Multi-region requests fan out per
  report and merge buckets / events / activity.
- **TTL caching** smooths the SOQL load — see the cache decorators
  in each backend module for the live values; tweak with both the
  poll interval and the TTL in mind so polls don't always hit
  stale data.
- **Coolan components** include curated attribute lists per asset
  type (see `_ATTR_KEYS_BY_ASSET` in `backend/coolan_client.py`).
- **Patchplan** indexes by lowercase hostname and by (room, rack)
  with prefix-zero normalisation so GUS' `E04` matches the sheet's
  `e4`. See `backend/patchplan.py`.

## Code map

A condensed pointer list — read the files for the full picture.

**Backend (`backend/`):**
- `main.py` — FastAPI app, every REST endpoint.
- `gus_client.py` — SF report parsing, `SITE_REPORTS`, status
  colours, activity log SOQL.
- `case_detail.py` — Per-case detail builder (Case + Tech_Asset,
  picklists, lookups). Where new SF write paths go.
- `coolan_client.py` — Coolan GraphQL (machines, components,
  rack-server lookup, temperature snapshot).
- `mom_client.py` — mom.dmz: Elasticsearch topology + Argus temps
  + Coolan rack-server join.
- `patchplan.py` — Master patchplan source/index/cache.
- `chat.py` — AI chat sidebar backend: tool definitions + LLM
  streaming via the SF LLM gateway.
- `update_check.py` — Polls `widash-releases` for newer tags.

**Frontend (`frontend/src/`):**
- `App.tsx` — Top-level shell, polling, settings modal wire-up.
- `api.ts` — All HTTP calls. **Always use `apiFetch` for `/api/...`**
  so `X-Report-Id` is attached.
- `components/` — Each major UI block lives in its own file
  (Header, ActivityLog, CaseDetailSheet, ChatSidebar, …).
- `hooks/` — Reusable state + behaviour (useWriteMode, useLanguage,
  usePolling, useTooltips, …).
- `statusColors.ts` — Colour map for non-active statuses. **Must
  stay in sync with `STATUS_COLORS` in `backend/gus_client.py`.**

**Local data (gitignored):**
- `~/.widash/patchplan/*.csv` — patchplan CSVs.
- `~/.widash/coolan_auth.json`, `~/.widash/mom_auth.json` — auth
  files (chmod 600).

## What's deliberately not built

- **Pushing changes back to the Google Sheet.** Patchplan is read-only.
- **Caching SF tokens server-side.** We re-read from the sf-CLI on
  every request; that's fine because sf-CLI is local.
- **A Sheets-API source for the patchplan.** The `PatchplanSource`
  interface is ready for it; we use local CSV exports until OAuth
  setup is worth doing.
- **Email, Slack, GUS Mentions inbox in WiDash.** Out of scope.

## Things to know when extending

- **Never commit writes that were not explicitly requested.** Every
  SF write goes through the Writes-mode pill in the header — the
  default is OFF. The confirm modal makes the diff explicit; the
  initial Status save is the simplest write path to study.
- **Polling never makes writes.** All polling endpoints are pure GETs
  and they're vetoed when the user has unsaved drafts / open confirm
  modal / in-flight save.
- **Region scoping**: anything that runs SOQL across cases must
  derive its site set from the active report
  (`_report_site_codes`) rather than from a hardcoded list. Same
  for activity log CaseHistory queries.
- **Don't hardcode column letters in CSV parsers.** The master
  patchplan has 30/31/32/33-column variants; `_parse_csv` finds
  columns by header name.

## When the SF token rotates

Run `sf org login web` again, then click **Retry** in the
auth-expired banner (or just wait — the next poll picks up the
fresh token automatically).
