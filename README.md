# WiDash

A local RMA dashboard for datacenter engineers. Reads cases from a
GUS report, talks to Coolan for component health, walks the
master-patchplan to surface cable connections, joins mom.dmz topology
with Argus time-series for live rack temperatures, and lets you read +
write Salesforce cases, chatter, and case fields without leaving the
tab.

Default deployment is Frankfurt, but the report id is configurable
per user via the in-app settings modal so the same binary works for
any DCEng region as soon as someone registers their site's RMA
report.

## Setup

Once per machine.

```bash
# Salesforce login (sf-CLI). Has to be done before WiDash is started
# and re-done whenever the SF session expires.
sf org login

# Backend deps
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate

# Frontend deps
cd ../frontend
bun install
cd ..
```

## Run

```bash
./start.sh
```

Opens `http://localhost:5173`. Backend API is at `http://localhost:8000`.

On first launch the **Region settings** modal opens automatically.
Pick your GUS RMA report from the dropdown (Frankfurt is preconfigured)
or paste a custom report id. WiDash auto-detects your region from
your last 90 days of edited cases and pre-fills the suggestion.

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
  browser via the gear icon.
- **Background polling**: dashboard auto-refreshes every 15s so
  status changes from colleagues / GUS itself propagate without a
  manual reload. Pauses when the tab is hidden.

### Case sheet
Bottom sheet that opens when you click a ticket. Up to one open at a
time; the others minimise into a draggable tab bar (horizontal
scroll, optional pin to dock above the open sheet).

- **Header**: case number · asset path with U-position
  (`FRA3-14.1-124-E04-HU14`) · status pill (clickable, dropdown of
  the 11 RMA statuses) · Coolan reporting state · Case category /
  subcategory (cascading) / resolution picker pills · live `LIVE`
  badge when the latest detail is in.
- **Body sections** read from `/api/case/{id}`: Identification,
  Responsible parties (case owner, team, ICO/IDO, …), Datacenter &
  routing, Classification, Workflow, Times. Plus the full asset
  record. Per-section edit mode → diff confirm modal → write through
  guarded by the global Writes pill.
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
  Sheet, dropped into `<repo>/patchplan/`. Backend polls the
  directory every 3 minutes and only re-parses on file changes
  (mtime+size hash). To refresh: re-download tabs as CSV from
  Google Sheets. The `LocalCsvSource` is one implementation behind
  a `PatchplanSource` interface; a future Sheets-API or shared-link
  source slots in without touching the UI.

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
  regions (Frankfurt + Paris + …); each region's site pills appear
  alongside each other in the header.
- Auto-detect picks your region from your recent SF activity. New
  regions get added by editing `SITE_REPORTS` in
  `backend/gus_client.py` — once a report id is registered there,
  every engineer in that region picks it up on next reload.

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
                        └────────────────────────────────┘
```

- **Auth**: backend reads the SF session from `sf org display` on
  every request (cached briefly). When the token rotates, the
  per-report `GusClient` cache is dropped.
- **Per-report clients**: a separate `GusClient` instance per report
  id keeps caches isolated. Multi-region requests fan out and merge
  buckets / events.
- **TTL caching** for active rmas / detail / activity (10s),
  case detail + feed (10s), per-uuid Coolan components (TtlCache
  default 30s). Manual refresh + 15s dashboard poll keep things
  fresh.
- **Coolan components** include curated attribute lists per asset
  type (see `_ATTR_KEYS_BY_ASSET` in `backend/coolan_client.py`).
- **Patchplan** indexes by lowercase hostname and by (room, rack)
  with prefix-zero normalisation so GUS' `E04` matches the sheet's
  `e4`. See `backend/patchplan.py`.

## Files

```
backend/
  main.py            FastAPI app, all REST endpoints
  gus_client.py      Salesforce report parsing, status colours, activity log
  case_detail.py     Per-case detail builder (Case + Tech_Asset, picklists, lookups)
  coolan_client.py   Coolan GraphQL client (machines, components, attributes,
                       rack-server lookup, temperature snapshot)
  coolan_browser.py  Headless SSO via Playwright
  coolan_auth.py     Persistent Coolan auth file
  mom_client.py      mom.dmz client: ES topology + Argus temps + Coolan join
  mom_auth.py        Persistent mom.dmz cookie file
  patchplan.py       Master patchplan source/index/cache
  sf_session.py      sf-CLI session reader with retry
  cache.py           In-memory TTL cache
  models.py          Pydantic types shared between layers

frontend/src/
  App.tsx                      Top-level shell, polling, settings modal wire-up
  api.ts                       All HTTP calls. apiFetch attaches X-Report-Id
  statusColors.ts              FRA-style colour map for non-active statuses
  assetPath.ts                 Asset-path / U-position formatting
  components/
    DonutCard.tsx              Active RMA donut + center stack
    LegendCard.tsx             RTS today / mine open / mine closed pills
    DetailsTable.tsx           Per-status ticket list with column manager
    ActivityLog.tsx            Status changes + comments with all the filters
    CaseDetailSheet.tsx        The big bottom sheet
    CaseTabsBar.tsx            Minimised case-tab pills
    ChatterPanel.tsx           Right-hand chatter / case-comments / email column
    PatchplanExplorer.tsx      Floating bubble + room/rack drilldown
    TempsExplorer.tsx          🌡 overlay: rooms → racks → devices → chart/snapshot
    MomStatusPill.tsx          Header pill for the mom.dmz cookie
    RegionSettingsModal.tsx    First-run + gear modal
    TextTooltip.tsx            Draggable / resizable tooltips
    EditConfirmModal.tsx       Diff confirm before SF write
    sheetSections.ts           Mock sections used until live detail arrives
    sheetChatter.ts            Mock chatter (rare fallback)
  hooks/
    useCaseSheets.ts           Per-tab persistence + tabsPinned global
    useFontSize.ts             S/M/L scale via html font-size
    useLanguage.ts             EN/DE translations + locale helpers
    useTheme.ts                Light/dark
    useTooltips.ts             openText / openLinks / openKv tooltip stack
    useSectionEdits.ts         Per-section draft store + diff
    useColumnConfig.ts         Generic + DetailsTable-specific column config
    useTabRefocus.ts           Reload when the tab regains focus after >30s
    usePolling.ts              Visibility-aware periodic poll
    useWriteMode.ts            Global Writes pill state
    useSort.ts                 Generic sort

patchplan/                     CSVs exported from the master Google Sheet
  *.csv                        (gitignored — local data only)
```

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
  derive its site set from the active report (`_report_site_codes`)
  rather than hardcoded `FRA1/2/3`. Same for activity log
  CaseHistory queries.
- **Don't hardcode column letters in CSV parsers.** The master
  patchplan has 30/31/32/33-column variants; `_parse_csv` finds
  columns by header name.
```

## When the SF token rotates
Run `sf org login` again, then click the refresh button in the
WiDash header (or wait for the next poll — the auth-expired banner
links to the same flow).
