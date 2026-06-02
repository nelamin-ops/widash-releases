import logging
import re
import time
import requests
from fastapi import Depends, FastAPI, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from simple_salesforce import Salesforce
from simple_salesforce.exceptions import (
    SalesforceExpiredSession, SalesforceError,
)

logger = logging.getLogger("widash")
from . import case_detail, coolan_auth, coolan_browser, coolan_client, sf_session
from . import patchplan as patchplan_mod
from . import update_check
from .cache import TtlCache
from .gus_client import (
    GusClient, DEFAULT_REPORT_ID, SITE_REPORTS, install_connection_retry,
)
from .models import (
    ActivityResponse, CaseDetailResponse, RmaActiveResponse, RmaDetailResponse,
)

app = FastAPI(title="WiDash API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_cache = TtlCache(ttl_seconds=30)
# Patchplan: index of all master-patchplan CSV exports, used by the
# case sheet to show "what cables connect to this device". The cache
# polls the source (currently LocalCsvSource → ~/.widash/patchplan/)
# every few minutes and only re-parses on file changes — see
# PatchplanCache.
_patchplan = patchplan_mod.PatchplanCache(
    source=patchplan_mod.LocalCsvSource(),
    poll_seconds=180.0,
)
# One client per report id — caches differ between reports, so we keep
# them separate. The token is shared across all entries; rotating the
# token drops the whole map.
_clients_by_report: dict[str, GusClient] = {}
_singleton_token: str | None = None

_VALID_REPORT_ID = re.compile(r"^[a-zA-Z0-9]{15,18}$")


def _resolve_report_ids(x_report_id: str | None) -> list[str]:
    """Parse the X-Report-Id header into a list of valid report ids.

    Accepts a single id or a comma-separated list. Invalid tokens are
    dropped silently. Falls back to ``[DEFAULT_REPORT_ID]`` when the
    header is missing or empty after filtering.
    """
    if not x_report_id:
        return [DEFAULT_REPORT_ID]
    parts = [p.strip() for p in x_report_id.split(",") if p.strip()]
    valid = [p for p in parts if _VALID_REPORT_ID.match(p)]
    return valid or [DEFAULT_REPORT_ID]


def _ensure_session() -> "sf_session.SfSession":
    try:
        return sf_session.get_session()
    except sf_session.SfSessionError as e:
        raise SalesforceExpiredSession(
            url="", status=401, resource_name="sf_session", content=[str(e)],
        )


def _resolve_clients(report_ids: list[str]) -> list[GusClient]:
    """Return a GusClient per report id, sharing the SF session.

    Token rotation invalidates the entire client cache at once so the
    next batch of requests sees the fresh credentials.
    """
    global _clients_by_report, _singleton_token
    session = _ensure_session()
    if _singleton_token != session.access_token:
        _clients_by_report = {}
        _singleton_token = session.access_token

    clients: list[GusClient] = []
    for rid in report_ids:
        client = _clients_by_report.get(rid)
        if client is None:
            sf = Salesforce(
                instance_url=session.instance_url,
                session_id=session.access_token,
            )
            install_connection_retry(sf)
            client = GusClient(sf=sf, report_id=rid)
            _clients_by_report[rid] = client
            logger.info(
                "Built GusClient for sf user %s with report %s",
                session.username, rid,
            )
        clients.append(client)
    return clients


def get_gus_client(
    x_report_id: str | None = Header(default=None, alias="X-Report-Id"),
) -> GusClient:
    """Single-report dependency for endpoints that don't merge data
    across regions (case detail, lookup, comment write, etc.). Picks
    the first id when the header carries a list."""
    return _resolve_clients(_resolve_report_ids(x_report_id))[0]


def get_gus_clients(
    x_report_id: str | None = Header(default=None, alias="X-Report-Id"),
) -> list[GusClient]:
    """Multi-report dependency for endpoints that merge across
    regions: active rmas, status detail lists, activity log."""
    return _resolve_clients(_resolve_report_ids(x_report_id))


@app.exception_handler(SalesforceExpiredSession)
async def handle_expired(_, __):
    return JSONResponse(
        status_code=401,
        content={"error": "auth_expired",
                 "message": "Run `sf org login` and retry."},
    )


@app.exception_handler(SalesforceError)
async def handle_sf_error(_, exc):
    # Log full exception server-side; return only a generic message to the
    # client so SOQL fragments / instance URL don't leak into the browser.
    logger.exception("Salesforce error: %s", exc)
    return JSONResponse(
        status_code=502,
        content={
            "error": "salesforce_error",
            "message": "Salesforce request failed. Check the server log.",
        },
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/me")
def get_me(client: GusClient = Depends(get_gus_client)):
    """Return the active SF user's id / username / name.

    The frontend uses this for the activity log "Me" filter so we
    never hardcode a particular engineer's identity — every user gets
    their own filter automatically.
    """
    info = client.get_current_user_info()
    if info is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session", "message": "No Salesforce client."},
        )
    return info


@app.get("/api/regions")
def list_regions():
    """Return the curated map of region prefix -> report id.

    The frontend uses this to populate the "add region" dropdown in the
    settings modal. New regions get added by editing SITE_REPORTS in
    backend/gus_client.py — once a report id is registered there,
    every engineer in that region picks it up on next reload without
    any per-user setup.
    """
    return {
        "regions": [
            {"prefix": prefix, "reportId": report_id}
            for prefix, report_id in sorted(SITE_REPORTS.items())
            if report_id  # skip null placeholders
        ],
    }


@app.get("/api/region/detect")
def detect_region(client: GusClient = Depends(get_gus_client)):
    """Best-effort guess of which region/report applies to this user.

    Looks at the cases the active SF user has modified in the last 90
    days, picks the most-common ``SM_Data_Center_Facility__c`` token,
    extracts the 3-letter prefix (FRA / CDG / LON / …), and returns
    the matching report id from ``SITE_REPORTS`` if we have one
    on file. Frontend uses this to decide whether the first-run
    settings modal can pre-fill or whether the user has to enter a
    report id manually.
    """
    info = client.get_current_user_info()
    sf = client._sf
    if info is None or sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session", "message": "No Salesforce client."},
        )
    user_id = info.get("id")
    try:
        rows = sf.query(
            "SELECT SM_Data_Center_Facility__c FROM Case "
            f"WHERE LastModifiedById = '{user_id}' "
            "AND LastModifiedDate = LAST_N_DAYS:90 LIMIT 200"
        )["records"]
    except SalesforceError:
        rows = []

    from collections import Counter
    sites: Counter[str] = Counter()
    for r in rows:
        v = r.get("SM_Data_Center_Facility__c") or ""
        for tok in v.split(";"):
            tok = tok.strip().upper()
            if tok and re.match(r"^[A-Z]{2,4}[0-9]{1,3}[A-Z]?$", tok):
                sites[tok] += 1

    most_common = sites.most_common(1)
    site_prefix: str | None = None
    if most_common:
        m = re.match(r"^([A-Z]{2,4})", most_common[0][0])
        if m:
            site_prefix = m.group(1)

    suggested_report = SITE_REPORTS.get(site_prefix or "")
    return {
        "userId": user_id,
        "sitePrefix": site_prefix,
        "suggestedReportId": suggested_report,
        "knownRegions": sorted(SITE_REPORTS.keys()),
        "siteCounts": dict(sites),
        "sampleSize": len(rows),
    }


# Site codes look like 3-letter prefix + 1-3 chars (FRA1, CDG2, LON3,
# PHX1A, …). We don't hardcode the set — the active report decides
# which sites are real.
_SITE_PATTERN = re.compile(r"^[A-Z]{2,4}[0-9]{1,3}[A-Z]?$")


def _parse_locations(raw: str | None) -> set[str] | None:
    """Parse a comma-separated location filter; returns None for "all".

    Accepts any reasonable site code shape (FRA3, CDG1, LON2, …) so the
    same backend can be re-pointed at a different region's report
    without needing a code change here.
    """
    if not raw:
        return None
    parts = {p.strip().upper() for p in raw.split(",") if p.strip()}
    parts = {p for p in parts if _SITE_PATTERN.match(p)}
    return parts or None


def _report_ids_key(clients: list[GusClient]) -> str:
    """Stable cache-key fragment so single-region and multi-region
    payloads stay isolated."""
    return ",".join(sorted(c._report_id for c in clients))


def _merge_active_rmas(
    parts: list[RmaActiveResponse],
) -> RmaActiveResponse:
    """Combine per-region active-rma responses into a single payload.

    Buckets are summed by status (sev breakdowns + runtime totals add
    up across regions). Sites and locationCounts unions naturally;
    myRtsOpen lists concatenate. fetchedAt picks the most recent.
    """
    from .models import StatusBucket, PrioBreakdown
    if not parts:
        raise ValueError("no responses to merge")

    bucket_acc: dict[str, dict] = {}
    for p in parts:
        for b in p.buckets:
            entry = bucket_acc.get(b.status)
            if entry is None:
                bucket_acc[b.status] = {
                    "count": b.count,
                    "color": b.color,
                    "prio": dict(b.prioBreakdown.model_dump()),
                    "runtime": b.totalRuntimeSeconds,
                }
            else:
                entry["count"] += b.count
                entry["runtime"] += b.totalRuntimeSeconds
                for sev, n in b.prioBreakdown.model_dump().items():
                    entry["prio"][sev] = entry["prio"].get(sev, 0) + n
                # Keep the first non-empty colour seen — every region
                # should agree, but if not we don't want to flicker.
                if not entry.get("color") and b.color:
                    entry["color"] = b.color
    buckets = [
        StatusBucket(
            status=status,
            count=data["count"],
            color=data["color"],
            prioBreakdown=PrioBreakdown(**data["prio"]),
            totalRuntimeSeconds=data["runtime"],
        )
        for status, data in bucket_acc.items()
    ]

    location_counts: dict[str, int] = {}
    for p in parts:
        for loc, n in (p.locationCounts or {}).items():
            location_counts[loc] = location_counts.get(loc, 0) + n

    sites: list[str] = []
    seen_sites: set[str] = set()
    for p in parts:
        for s in (p.sites or []):
            if s not in seen_sites:
                seen_sites.add(s)
                sites.append(s)

    my_rts_open: list = []
    closed_total = 0
    for p in parts:
        my_rts_open.extend(p.myRtsOpen)
        closed_total += p.myRtsClosedTotal

    return RmaActiveResponse(
        total=sum(p.total for p in parts),
        buckets=buckets,
        returnToServiceToday=sum(p.returnToServiceToday for p in parts),
        myRtsOpen=my_rts_open,
        myRtsClosedTotal=closed_total,
        locationCounts=location_counts,
        sites=sorted(sites),
        fetchedAt=max(p.fetchedAt for p in parts),
    )


@app.get("/api/rma/active", response_model=RmaActiveResponse)
def get_active(
    locations: str | None = Query(default=None),
    clients: list[GusClient] = Depends(get_gus_clients),
):
    locs = _parse_locations(locations)
    cache_key = (
        f"active:{_report_ids_key(clients)}:"
        f"{','.join(sorted(locs)) if locs else 'all'}"
    )
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    if len(clients) == 1:
        resp = clients[0].get_active_rmas(locations=locs)
    else:
        resp = _merge_active_rmas(
            [c.get_active_rmas(locations=locs) for c in clients],
        )
    # Short TTL so the dashboard's 15s polling actually picks up
    # status changes (made by us or a colleague) instead of seeing
    # the cached snapshot for half a minute.
    _cache.set(cache_key, resp, ttl_seconds=10)
    return resp


@app.get("/api/rma/active/{status}", response_model=RmaDetailResponse)
def get_active_by_status(
    status: str,
    locations: str | None = Query(default=None),
    clients: list[GusClient] = Depends(get_gus_clients),
):
    locs = _parse_locations(locations)
    cache_key = (
        f"detail:{_report_ids_key(clients)}:{status}:"
        f"{','.join(sorted(locs)) if locs else 'all'}"
    )
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    tickets: list = []
    for c in clients:
        tickets.extend(c.get_tickets_for_status(status, locations=locs))
    resp = RmaDetailResponse(status=status, tickets=tickets)
    # Same short TTL — the open details list refreshes alongside the
    # donut on each dashboard poll.
    _cache.set(cache_key, resp, ttl_seconds=10)
    return resp


@app.get("/api/activity", response_model=ActivityResponse)
def get_activity(
    type: str = Query(default="all", pattern="^(all|status_change|comment)$"),
    limit: int = Query(default=200, ge=1, le=1000),
    locations: str | None = Query(default=None),
    includeBots: bool = Query(default=False),
    clients: list[GusClient] = Depends(get_gus_clients),
):
    locs = _parse_locations(locations)
    cache_key = (
        f"activity:{_report_ids_key(clients)}:{type}:{limit}:"
        f"{','.join(sorted(locs)) if locs else 'all'}:"
        f"bots={int(includeBots)}"
    )
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    merged: list = []
    for c in clients:
        merged.extend(c.get_activity_events(
            activity_type=type, limit=limit, locations=locs,
            include_bots=includeBots,
        ))
    # Re-sort across regions and trim to the requested limit so the
    # combined result behaves like a single feed.
    merged.sort(key=lambda e: e.timestamp, reverse=True)
    resp = ActivityResponse(events=merged[:limit])
    _cache.set(cache_key, resp, ttl_seconds=10)
    return resp


@app.post("/api/refresh")
def refresh():
    global _clients_by_report, _singleton_token
    _cache.clear()
    sf_session.invalidate_cache()  # force-reread sf CLI on next request
    _clients_by_report = {}
    _singleton_token = None
    return {"status": "refreshed"}


# ---------------------------------------------------------------- Patchplan ----


def _cable_to_dict(c: patchplan_mod.Cable) -> dict:
    return {
        "cableId": c.cable_id,
        "tab": c.tab,
        "cabled": c.cabled,
        "cableType": c.cable_type,
        "length": c.length,
        "comment": c.comment,
        "sideA": {
            "device": c.side_a.device, "port": c.side_a.port,
            "make": c.side_a.make, "room": c.side_a.room,
            "rack": c.side_a.rack, "uLoc": c.side_a.u_loc,
            "tile": c.side_a.tile,
        },
        "sideB": {
            "device": c.side_b.device, "port": c.side_b.port,
            "make": c.side_b.make, "room": c.side_b.room,
            "rack": c.side_b.rack, "uLoc": c.side_b.u_loc,
            "tile": c.side_b.tile,
        },
        "hops": [
            {"label": h.label, "panel": h.panel, "port": h.port}
            for h in c.hops
        ],
    }


@app.get("/api/patchplan/cables")
def patchplan_cables(
    hostname: str = Query(default="", min_length=0, max_length=120),
    room: str = Query(default="", min_length=0, max_length=40),
    rack: str = Query(default="", min_length=0, max_length=40),
    q: str = Query(default="", min_length=0, max_length=120),
):
    """Return master-patchplan cables matching the given filters.

    Three independent matchers, OR'd together:
    - ``hostname`` exact match (case-insensitive) on side A or side B
      device — useful when the RMA is on a network device that
      appears in the patchplan directly.
    - ``room`` + ``rack`` — every cable that lands in the same rack as
      the asset. Necessary for server RMAs since servers are not
      indexed in the patchplan, only the switches they patch into.
    - ``q`` substring match on either side's device, port, panel,
      cable id, or comment — engineer can manually narrow down.

    Empty filters → empty list (we never dump the whole sheet).
    """
    idx = _patchplan.get()
    seen_keys: set[tuple[str, str]] = set()
    cables: list = []
    def add(cs: list) -> None:
        for c in cs:
            k = (c.cable_id, c.tab)
            if k in seen_keys:
                continue
            seen_keys.add(k)
            cables.append(c)

    if hostname:
        add(idx.cables_for(hostname))
    if room and rack:
        add(idx.cables_for_rack(room, rack))
    if q:
        needle = q.strip().lower()
        if needle:
            for c in idx.cables:
                hay = " ".join((
                    c.cable_id, c.cable_type, c.length, c.comment,
                    c.side_a.device, c.side_a.port,
                    c.side_b.device, c.side_b.port,
                    *(h.panel for h in c.hops),
                    *(h.port for h in c.hops),
                )).lower()
                if needle in hay:
                    add([c])

    return {
        "hostname": hostname,
        "room": room, "rack": rack, "q": q,
        "revision": idx.revision[:24] if idx.revision else "",
        "fetchedAt": idx.fetched_at,
        "cables": [_cable_to_dict(c) for c in cables],
        "totalIndexed": len(idx.cables),
        "knownHosts": len(idx.by_host),
    }


_ROOM_NOISE_THRESHOLD = 50


@app.get("/api/patchplan/tree")
def patchplan_tree(
    showAll: bool = Query(default=False),
):
    """Aggregated rooms → racks → devices for the explorer.

    Returns the full hierarchy with cable counts at each level so the
    UI can render the room/rack drill-down without paging through
    cables. The cable rows themselves come from /api/patchplan/cables
    once the user picks a device.

    By default rooms with fewer than ``_ROOM_NOISE_THRESHOLD`` cable
    references are dropped — those entries are typically junk leaked
    in from misaligned spreadsheet rows (a u-position or device name
    landing in the room column). The frontend's "show all" toggle
    flips ``showAll=true`` to surface them anyway when the engineer
    needs to verify nothing's missing.
    """
    idx = _patchplan.get()
    # rooms[room] -> { racks: { rack: { devices: { name -> set(cable_ids) } } } }
    # We track cable_ids in a set so that a device appearing on the far end
    # of a cable (where room/rack may be blank) still gets counted once the
    # cable is attributed to its known rack via the other end.
    rooms: dict[str, dict] = {}
    for c in idx.cables:
        for end in (c.side_a, c.side_b):
            room = (end.room or "").strip()
            rack = (end.rack or "").strip()
            if not room or not rack:
                continue
            r = rooms.setdefault(room, {"cable_ids": set(), "racks": {}})
            r["cable_ids"].add(c.cable_id)
            rk = r["racks"].setdefault(rack, {"cable_ids": set(), "devices": {}})
            rk["cable_ids"].add(c.cable_id)

    # Second pass: for each device, count distinct cables via by_host so
    # cables where the device appears without a room/rack on its own end
    # are still included (e.g. SAN hosts that only have room on side_b).
    for c in idx.cables:
        for end in (c.side_a, c.side_b):
            room = (end.room or "").strip()
            rack = (end.rack or "").strip()
            device = (end.device or "").strip()
            if not room or not rack or not device:
                continue
            rk = rooms.get(room, {}).get("racks", {}).get(rack)
            if rk is None:
                continue
            dev_cables = rk["devices"].setdefault(device, set())
            # Count all cables for this device from the index, not just
            # the one end that has room+rack populated.
            if not dev_cables:
                dev_cables.update(
                    ca.cable_id for ca in idx.by_host.get(device.lower(), [])
                )
    rooms_out = []
    hidden_count = 0
    for name, body in sorted(rooms.items()):
        cable_count = len(body["cable_ids"])
        if not showAll and cable_count < _ROOM_NOISE_THRESHOLD:
            hidden_count += 1
            continue
        racks_out = []
        for rack_name, rack_body in sorted(body["racks"].items()):
            racks_out.append({
                "name": rack_name,
                "cables": len(rack_body["cable_ids"]),
                "devices": [
                    {"name": d, "cables": len(cable_set)}
                    for d, cable_set in sorted(
                        rack_body["devices"].items(),
                        key=lambda kv: (-len(kv[1]), kv[0]),
                    )
                ],
            })
        rooms_out.append({
            "name": name,
            "cables": cable_count,
            "racks": racks_out,
        })
    return {
        "rooms": rooms_out,
        "hiddenRoomsCount": hidden_count,
        "totalCables": len(idx.cables),
        "totalHosts": len(idx.by_host),
        "revision": idx.revision[:24] if idx.revision else "",
        "fetchedAt": idx.fetched_at,
    }


@app.post("/api/patchplan/refresh")
def patchplan_refresh():
    """Force re-read the patchplan source. Used by the manual refresh
    button on the case sheet's Connections section."""
    idx = _patchplan.force_refresh()
    return {
        "totalIndexed": len(idx.cables),
        "knownHosts": len(idx.by_host),
        "revision": idx.revision[:24] if idx.revision else "",
        "fetchedAt": idx.fetched_at,
    }


# ---------------------------------------------------------------- Updates ----

@app.get("/api/update-info")
def get_update_info():
    """Check GitHub Releases for a newer version of WiDash.

    Result is cached for 1 hour so this endpoint is safe to call on
    every dashboard load without hammering the GitHub API.
    """
    return update_check.get_update_info()


# ---------------------------------------------------------------- Coolan ----

class CoolanAuthIn(BaseModel):
    token: str | None = None
    cookie: str | None = None
    note: str = ""


@app.get("/api/coolan/status")
def coolan_status():
    return coolan_client.status()


@app.post("/api/coolan/auth")
def coolan_auth_set(payload: CoolanAuthIn):
    if not (payload.token or payload.cookie):
        return JSONResponse(
            status_code=400,
            content={"error": "missing_auth",
                     "message": "Provide token, cookie, or both."},
        )
    coolan_auth.save(payload.token, payload.cookie, payload.note)
    _cache.clear()  # any cached drained tickets need a fresh state lookup
    return coolan_client.status()


@app.delete("/api/coolan/auth")
def coolan_auth_clear():
    coolan_auth.clear()
    _cache.clear()
    return {"status": "cleared"}


@app.get("/api/case/{case_id}", response_model=CaseDetailResponse)
def get_case(case_id: str, client: GusClient = Depends(get_gus_client)):
    """Structured detail view for a single Case + its linked Tech_Asset."""
    cache_key = f"case:{case_id}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    sf = client._sf
    if sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session", "message": "No Salesforce client."},
        )
    # Look up the asset id from the cached active-rma rows since
    # Case.AssetId is usually empty in this org.
    asset_hint: str | None = None
    for r in client._cached_rows:
        if r.get("id") == case_id:
            asset_hint = r.get("assetId") or None
            break
    detail = case_detail.get_case_detail(sf, case_id, asset_id_hint=asset_hint)
    if detail is None:
        return JSONResponse(
            status_code=404,
            content={"error": "not_found", "message": f"Case {case_id} not found."},
        )
    # Short TTL — open case sheets poll this every 30s to pick up
    # colleague edits, so a 30s cache would mask half of them.
    _cache.set(cache_key, detail, ttl_seconds=10)
    return detail


# ---- write endpoints ------------------------------------------------------

class FieldChangeIn(BaseModel):
    apiName: str
    value: object | None = None


class CaseWriteIn(BaseModel):
    changes: list[FieldChangeIn] = []


def _invalidate_case_cache(case_id: str) -> None:
    """Drop any cached snapshot of this case so the next read is fresh."""
    _cache.delete(f"case:{case_id}")


def _do_write_record(
    sobject: str, record_id: str, changes: list[FieldChangeIn],
    client: GusClient,
):
    sf = client._sf
    if sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session",
                     "message": "No Salesforce client."},
        )
    try:
        case_detail.write_record_fields(
            sf, sobject, record_id,
            [{"apiName": c.apiName, "value": c.value} for c in changes],
        )
    except case_detail.WriteValidationError as e:
        return JSONResponse(
            status_code=400,
            content={"error": "validation_error", "message": str(e)},
        )
    except SalesforceExpiredSession:
        raise
    except SalesforceError as e:
        msg = str(e)
        # Salesforce returns INSUFFICIENT_ACCESS for permission denials; turn
        # those into a clean 403 so the UI can show "ask your admin".
        status = 403 if "INSUFFICIENT_ACCESS" in msg or "INSUFFICIENT" in msg else 502
        logger.exception("write_record_fields failed")
        return JSONResponse(
            status_code=status,
            content={"error": "salesforce_error", "message": msg[:500]},
        )
    return {"status": "ok"}


@app.patch("/api/case/{case_id}")
def patch_case(
    case_id: str,
    payload: CaseWriteIn,
    client: GusClient = Depends(get_gus_client),
):
    """Apply a field-changes payload to a Case. All-or-nothing."""
    result = _do_write_record("Case", case_id, payload.changes, client)
    if isinstance(result, JSONResponse):
        return result
    _invalidate_case_cache(case_id)
    return result


@app.patch("/api/asset/{asset_id}")
def patch_asset(
    asset_id: str,
    payload: CaseWriteIn,
    client: GusClient = Depends(get_gus_client),
):
    """Apply a field-changes payload to a Tech_Asset__c.

    Same shape as the case endpoint — schema-driven so it Just Works
    once the user's profile has the asset write permission.
    """
    result = _do_write_record(
        "Tech_Asset__c", asset_id, payload.changes, client,
    )
    if isinstance(result, JSONResponse):
        return result
    # Asset edits don't affect the case-detail cache directly, but the
    # case detail embeds asset values — clear anything that referenced
    # this asset so a re-read picks the fresh state.
    _cache.clear()
    return result


class CommentIn(BaseModel):
    source: str  # "chatter" | "caseComments"
    body: str
    parentFeedItemId: str | None = None


class CommentEditIn(BaseModel):
    """Edit body of an existing FeedItem (top-level Chatter post) or
    FeedComment (Chatter reply). Only the original author can update;
    Salesforce enforces that — we mirror it at the API layer."""
    kind: str  # "post" | "comment"
    body: str


@app.post("/api/case/{case_id}/comment")
def post_case_comment(
    case_id: str,
    payload: CommentIn,
    client: GusClient = Depends(get_gus_client),
):
    """Post a Chatter post / FeedComment / CaseComment for a case."""
    sf = client._sf
    if sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session",
                     "message": "No Salesforce client."},
        )
    body = (payload.body or "").strip()
    if not body:
        return JSONResponse(
            status_code=400,
            content={"error": "empty", "message": "Comment body is empty."},
        )
    try:
        if payload.source == "caseComments":
            sf.CaseComment.create({
                "ParentId": case_id,
                "CommentBody": body,
            })
        elif payload.source == "chatter" and payload.parentFeedItemId:
            sf.FeedComment.create({
                "FeedItemId": payload.parentFeedItemId,
                "CommentBody": body,
            })
        elif payload.source == "chatter":
            sf.FeedItem.create({
                "ParentId": case_id,
                "Body": body,
                "Type": "TextPost",
            })
        else:
            return JSONResponse(
                status_code=400,
                content={"error": "bad_source",
                         "message": f"unknown source {payload.source!r}"},
            )
    except SalesforceExpiredSession:
        raise
    except SalesforceError as e:
        logger.exception("comment write failed")
        return JSONResponse(
            status_code=502,
            content={"error": "salesforce_error", "message": str(e)[:500]},
        )
    # Invalidate any activity cache so the new comment shows up on the
    # next read.
    _cache.delete_prefix("activity:")
    _cache.delete_prefix(f"case_feed:{case_id}:")
    return {"status": "ok"}


@app.patch("/api/case/{case_id}/comment/{entry_id}")
def patch_case_comment(
    case_id: str,
    entry_id: str,
    payload: CommentEditIn,
    client: GusClient = Depends(get_gus_client),
):
    """Update the body of one of the user's own Chatter posts/replies.

    ``case_id`` is purely for cache invalidation; the actual record is
    addressed via ``entry_id`` + ``kind``. Salesforce enforces the
    ownership check (a non-author update raises INSUFFICIENT_ACCESS).
    """
    sf = client._sf
    if sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session", "message": "No Salesforce client."},
        )
    body = (payload.body or "").strip()
    if not body:
        return JSONResponse(
            status_code=400,
            content={"error": "empty", "message": "Comment body is empty."},
        )
    try:
        if payload.kind == "post":
            sf.FeedItem.update(entry_id, {"Body": body})
        elif payload.kind == "comment":
            sf.FeedComment.update(entry_id,
                status_code=400,
                content={"error": "bad_kind", "message": f"unknown kind {payload.kind!r}"},
            )
    except SalesforceExpiredSession:
        raise
    except SalesforceError as e:
        msg = str(e)
        status = 403 if "INSUFFICIENT" in msg else 502
        logger.exception("comment edit failed")
        return JSONResponse(
            status_code=status,
            content={"error": "salesforce_error", "message": msg[:500]},
        )
    _cache.delete_prefix(f"case_feed:{case_id}:")
    return {"status": "ok"}


_SF_ID_LOOSE = re.compile(r"^[a-zA-Z0-9]{15,18}$")


@app.get("/api/lookup/{sobject}")
def lookup_search(
    sobject: str,
    q: str = Query(default="", min_length=0, max_length=80),
    limit: int = Query(default=12, ge=1, le=200),
    listType: str | None = Query(default=None, max_length=40),
    parentId: str | None = Query(default=None, max_length=18),
    recordTypeFilter: str | None = Query(default=None, max_length=40),
    client: GusClient = Depends(get_gus_client),
):
    """Type-ahead / dropdown search for lookup fields on the case sheet.

    Allow-listed per sobject so untrusted input can never broaden the
    SOQL surface beyond what's rendered in the UI. ``SM_General_Picklist__c``
    additionally supports ``listType`` (Category/Subcategory/Resolution)
    and ``parentId`` (cascading Subcategory) parameters.
    """
    # Allow-list of objects + the field used for the friendly label.
    # User has Username + Name; everything else just has Name.
    allowed: dict[str, tuple[str, str]] = {
        "ADM_Scrum_Team__c": ("Name", "Name"),
        "User": ("Name", "Username"),
        "SM_Business_Name__c": ("Name", "Name"),
        "SM_General_Picklist__c": ("Name", "Name"),
    }
    spec = allowed.get(sobject)
    if spec is None:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_sobject",
                     "message": f"{sobject} is not searchable here."},
        )
    name_field, alt_field = spec
    sf = client._sf
    if sf is None:
        return JSONResponse(
            status_code=503,
            content={"error": "no_sf_session", "message": "No Salesforce client."},
        )
    # Escape single quotes — SOQL strings don't allow them unescaped.
    safe_q = (q or "").replace("\\", "\\\\").replace("'", "\\'")
    where_parts: list[str] = []
    if safe_q:
        where_parts.append(f"({name_field} LIKE '%{safe_q}%'"
            + (f" OR {alt_field} LIKE '%{safe_q}%'" if alt_field != name_field else "")
            + ")")

    if sobject == "SM_General_Picklist__c":
        # Restrict to active rows of the requested partition (Category /
        # Subcategory / Resolution) and the case record-type filter.
        where_parts.append("Active__c = true")
        if listType in ("Category", "Subcategory", "Resolution"):
            where_parts.append(f"Related_List_Type__c = '{listType}'")
        if recordTypeFilter and re.match(r"^[A-Za-z0-9 _-]{1,40}$", recordTypeFilter):
            where_parts.append(f"Object_RecordType_Filter__c = '{recordTypeFilter}'")
        if parentId and _SF_ID_LOOSE.match(parentId):
            where_parts.append(f"Related_Choice__c = '{parentId}'")

    where = (
        f"WHERE {' AND '.join(where_parts)}"
        if where_parts else ""
    )
    extra_select = f", {alt_field}" if alt_field != name_field else ""
    soql = (
        f"SELECT Id, {name_field}{extra_select} FROM {sobject} {where} "
        f"ORDER BY {name_field} LIMIT {int(limit)}"
    )
    try:
        rows = sf.query(soql).get("records", [])
    except SalesforceError as e:
        logger.exception("lookup search failed")
        return JSONResponse(
            status_code=502,
            content={"error": "salesforce_error", "message": str(e)[:300]},
        )
    return {
        "sobject": sobject,
        "results": [
            {
                "id": r["Id"],
                "name": (
                    r.get(name_field)
                    or r.get(alt_field)
                    or ""
                ),
            }
            for r in rows
        ],
    }


_avatar_cache: dict[str, tuple[float, bytes, str]] = {}
_AVATAR_TTL = 3600.0  # seconds


@app.get("/api/avatar/{user_id}")
def get_avatar(
    user_id: str,
    client: GusClient = Depends(get_gus_client),
):
    """Proxy a Salesforce profile photo through our session.

    SF profile photos require an authenticated SF session cookie to
    download — the browser doesn't have that, so direct <img src> to
    SmallPhotoUrl 401s for any user the browser hasn't recently
    visited in GUS. We fetch with the sf-CLI token instead, cache for
    an hour, and serve the bytes directly.
    """
    if not user_id or not user_id.replace(".", "").isalnum():
        return JSONResponse(status_code=400, content={"error": "bad_id"})
    cached = _avatar_cache.get(user_id)
    now = time.time()
    if cached and now - cached[0] < _AVATAR_TTL:
        return Response(content=cached[1], media_type=cached[2])
    sf = client._sf
    if sf is None:
        return JSONResponse(status_code=503, content={"error": "no_sf_session"})
    try:
        rows = sf.query(
            f"SELECT SmallPhotoUrl FROM User WHERE Id = '{user_id}' LIMIT 1"
        )["records"]
    except SalesforceError:
        return JSONResponse(status_code=502, content={"error": "salesforce_error"})
    if not rows:
        return JSONResponse(status_code=404, content={"error": "not_found"})
    url = rows[0].get("SmallPhotoUrl") or ""
    if not url:
        return JSONResponse(status_code=404, content={"error": "no_photo"})
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"Bearer {sf.session_id}"},
            timeout=10,
        )
    except requests.RequestException:
        return JSONResponse(status_code=502, content={"error": "fetch_failed"})
    if r.status_code != 200:
        return JSONResponse(
            status_code=r.status_code,
            content={"error": "upstream_error"},
        )
    ctype = r.headers.get("Content-Type") or "image/png"
    _avatar_cache[user_id] = (now, r.content, ctype)
    return Response(content=r.content, media_type=ctype)


@app.get("/api/case/{case_id}/feed")
def get_case_feed(
    case_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    client: GusClient = Depends(get_gus_client),
):
    """Combined Chatter + CaseComment + EmailMessage feed for one case."""
    cache_key = f"case_feed:{case_id}:{limit}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    entries = client.get_case_feed(case_id, limit=limit)
    resp = {"caseId": case_id, "entries": entries}
    # Short TTL — open sheets poll this so colleague comments / status
    # changes show up within ~10s instead of being masked by the cache.
    _cache.set(cache_key, resp, ttl_seconds=10)
    return resp


@app.get("/api/coolan/machine/{uuid}/components")
def coolan_machine_components(uuid: str):
    """Read-only Coolan components list for a machine UUID.

    Used by the case sheet to show which hardware components are
    healthy / removed / missing without the user having to leave the
    dashboard. Cached per uuid for the same TtlCache window as the
    rest of the read path.
    """
    cache_key = f"coolan:components:{uuid}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    rows = coolan_client.get_components(uuid)
    resp = {"machineUuid": uuid, "components": rows}
    _cache.set(cache_key, resp)
    return resp


@app.post("/api/coolan/auto")
def coolan_auth_auto(headless: bool = True):
    """Run the headless SSO flow and persist the resulting token.

    Falls back to a visible browser when ``headless=false`` so the
    user can complete MFA interactively on the first run.
    """
    result = coolan_browser.refresh(headless=headless)
    if result.get("ok"):
        _cache.clear()
        # Mirror the regular auth-set flow's response shape.
        return coolan_client.status()
    return JSONResponse(
        status_code=400 if result.get("needs_interaction") else 500,
        content={
            "error": "coolan_auto_failed",
            "message": result.get("error", "unknown"),
            "needsInteraction": bool(result.get("needs_interaction")),
        },
    )
