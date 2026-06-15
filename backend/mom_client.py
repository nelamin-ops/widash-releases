"""mom.dmz / Argus client.

mom.dmz is a Single-Page App that exposes its data via two backend APIs:

  1. ``/mom/api/elasticsearch/search?index=grok-device``  – topology
     (which devices live in which rack/cage/room for a given site).
  2. ``/mom/api/argus/metrics/raw``                        – Argus
     time-series store, gives the actual temperature readings.

We hit both with the same Salesforce SSO cookie the user pastes via the
🌡 status pill. Topology + temperatures are joined here on the device
name so the frontend gets a flat ``rack -> devices -> temp`` shape.

Argus expression layout (we only build these from allow-listed inputs)::

    <timeframe>:<scope>:<metric>{<tag-filters>}:<aggregator>:<downsampler>

Example::

    -30m:-0m:network.FRA.AGG.*:snmp.gauge.entSensorValue-module-1__FRONT
        {device=*}:max:1m-max
"""
from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional, TypedDict

from . import coolan_client, mom_auth

logger = logging.getLogger(__name__)

MOM_BASE = "https://mom.dmz.salesforce.com"
ARGUS_PATH = "/mom/api/argus/metrics/raw"
ES_PATH = "/mom/api/elasticsearch/search"

# Reuse the Coolan macOS-keychain SSL bundle — Salesforce internal services
# share the same internal CA, so the trust setup we already did for Coolan
# also covers mom.dmz.
_SSL_CTX = coolan_client._SSL_CTX  # noqa: SLF001 (intentional reuse)

# --- Allow-lists ------------------------------------------------------------

# Map a WiDash site code (FRA3, CDG2, …) to:
#   - the lower-case mom.dmz site name used in ES queries ("fra", "cdg")
#   - the upper-case Argus region prefix used in metric paths ("FRA", "CDG")
# A single mom.dmz site may host multiple WiDash facilities (FRA1/2/3 all
# live under "fra"), so we filter the ES response by `facility` to scope
# the result to the one the user picked.
_SITE_MAP: dict[str, tuple[str, str]] = {
    "FRA1": ("fra", "FRA"),
    "FRA2": ("fra", "FRA"),
    "FRA3": ("fra", "FRA"),
    "CDG1": ("cdg", "CDG"),
    "CDG2": ("cdg", "CDG"),
    "CDG3": ("cdg", "CDG"),
}

# Switch sensor labels we know about, in display order. The
# entSensorValue path uses "module-1__<sensor>" — keys are the labels
# we surface in the UI, values are the suffix segment used in Argus.
SWITCH_SENSORS: tuple[tuple[str, str], ...] = (
    ("Front",         "FRONT"),
    ("Front-Left D1", "Front-Left__D1__"),
    ("Front-Right D2", "Front-Right__D2__"),
    ("Back",          "BACK"),
    ("Back D3",       "Back__D3__"),
)
_SENSOR_SUFFIXES = {label: suffix for label, suffix in SWITCH_SENSORS}

# Timeframes the UI exposes. Keys are the dropdown labels, values are
# Argus shorthand. Anything outside this set is rejected.
TIMEFRAMES: dict[str, str] = {
    "30m": "-30m:-0m",
    "1h":  "-1h:-0m",
    "6h":  "-6h:-0m",
    "24h": "-24h:-0m",
    "7d":  "-7d:-0m",
    "30d": "-30d:-0m",
}

# Downsampling matched to timeframe so we don't blow past Argus's
# point-count caps on long ranges.
_DOWNSAMPLE_BY_TIMEFRAME = {
    "30m": "1m-max",
    "1h":  "1m-max",
    "6h":  "5m-max",
    "24h": "15m-max",
    "7d":  "1h-max",
    "30d": "6h-max",
}

# Aggregations the user can pick.
AGGREGATIONS: tuple[str, ...] = ("max", "avg", "min")

# Argus device names look like "leaf3-ncg6-fra3", "sw2c-pod320-ncg28-fra3"
# etc. Letters/digits/hyphens, lower-case.
_DEVICE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")


class Series(TypedDict, total=False):
    """One metric series returned by Argus."""
    target: str
    device: str
    sensor: str
    datapoints: list[list[float]]


class Rack(TypedDict, total=False):
    """A rack tile in the overview."""
    fullValue: str    # the long asset-location/name from grok-device
    label: str        # rack number, e.g. "G35"
    room: str         # cage_room, e.g. "424"
    cage: str         # first letter of label, e.g. "G"
    tempC: Optional[float]
    color: str


class Room(TypedDict):
    name: str
    racks: list[Rack]


class Device(TypedDict, total=False):
    device: str
    label: str
    pos: str          # rackupos_number
    tempC: Optional[float]
    color: str
    # Where the row came from. "mom" = network switch via mom.dmz / Argus,
    # "coolan" = server via Coolan. The frontend renders a per-row badge
    # plus, for Coolan rows, the three probe values below instead of the
    # single tempC.
    source: str
    # Coolan-only: individual probe values. Inlet / Exhaust / max(CPU)
    # are surfaced because Coolan has no machine-level aggregate and the
    # engineer wants to see the breakdown. None when the probe is absent
    # or its parsed_value didn't coerce to float.
    tempInlet: Optional[float]
    tempExhaust: Optional[float]
    tempCpuMax: Optional[float]
    # Coolan-only: machine UUID, used by the snapshot detail panel.
    # Hostnames aren't unique enough (we've seen "pod306:puppet"-style
    # collisions across racks) so we pass the UUID through directly.
    coolanUuid: Optional[str]


class MomError(Exception):
    """Generic mom.dmz client error."""


class MomAuthError(MomError):
    """The mom.dmz API rejected the saved cookie (401/403)."""


# --- Auth + HTTP helpers ----------------------------------------------------

def _auth_headers() -> dict[str, str]:
    auth = mom_auth.load()
    if not auth or not auth.get("cookie"):
        raise MomAuthError("no auth configured")
    return {
        "Cookie": auth["cookie"],
        "Origin": MOM_BASE,
        "Referer": MOM_BASE + "/mom/datacenter-temperature?site=fra",
        "User-Agent": "Mozilla/5.0 WiDash/1.0",
        "X-Requested-With": "XMLHttpRequest",
    }


def _post_json(path: str, body: dict[str, Any], *, query: dict[str, str] | None = None) -> Any:
    url = MOM_BASE + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = _auth_headers()
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json, text/javascript, */*; q=0.01"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20, context=_SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise MomAuthError(f"HTTP {e.code}") from e
        raise MomError(f"HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise MomError(f"network error: {e}") from e


# --- Elasticsearch topology -------------------------------------------------

# Cache the last topology fetch per site for ~120s. The frontend overlay
# polls /api/temps/overview which already has its own 30s TTL, but if
# the user opens & closes the overlay quickly we still hit ES every
# time without this. Topology changes on the order of weeks (rack moves),
# so even minutes of staleness are fine.
_topology_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_TOPOLOGY_TTL_S = 120.0


def _es_query_for_site(site_lower: str) -> dict[str, Any]:
    """The same query mom.dmz's frontend uses — devices that report a
    temperature (= have ``airflow-direction`` in their SKU) for the given
    site."""
    return {
        "size": 5000,
        "_source": {"excludes": ["grok-json"]},
        "aggs": {
            "collection-site": {
                "terms": {"field": "collection-site.keyword", "size": 50},
            },
        },
        "query": {
            "bool": {
                "must": [
                    {"term": {"site": site_lower}},
                    {"exists": {"field": "asset.sku.value.airflow-direction"}},
                ],
            },
        },
    }


def _fetch_topology(site_lower: str) -> list[dict[str, Any]]:
    import time as _time
    now = _time.time()
    cached = _topology_cache.get(site_lower)
    if cached and now - cached[0] < _TOPOLOGY_TTL_S:
        return cached[1]
    payload = _post_json(
        ES_PATH,
        _es_query_for_site(site_lower),
        query={"index": "grok-device"},
    )
    data = payload.get("data") or {}
    hits_outer = data.get("hits") or {}
    hits = hits_outer.get("hits") or []
    sources = [h.get("_source") or {} for h in hits]
    _topology_cache[site_lower] = (now, sources)
    return sources


# --- Argus temperatures -----------------------------------------------------

def _validate_inputs(site: str, sensor: str, timeframe: str, agg: str) -> None:
    if site not in _SITE_MAP:
        raise MomError(f"unsupported site: {site!r}")
    if sensor not in _SENSOR_SUFFIXES:
        raise MomError(f"unknown sensor: {sensor!r}")
    if timeframe not in TIMEFRAMES:
        raise MomError(f"unsupported timeframe: {timeframe!r}")
    if agg not in AGGREGATIONS:
        raise MomError(f"unsupported aggregation: {agg!r}")


def _build_expression(*, site: str, sensor: str, timeframe: str, agg: str) -> str:
    _validate_inputs(site, sensor, timeframe, agg)
    region = _SITE_MAP[site][1]
    suffix = _SENSOR_SUFFIXES[sensor]
    timewindow = TIMEFRAMES[timeframe]
    downsample = _DOWNSAMPLE_BY_TIMEFRAME[timeframe]
    return (
        f"{timewindow}"
        f":network.{region}.AGG.*"
        f":snmp.gauge.entSensorValue-module-1__{suffix}"
        f"{{device=*}}"
        f":{agg}:{downsample}"
    )


def _extract_device(target: str) -> str:
    """Pull the device name out of an Argus target path.

    Targets look like
    ``network.FRA.AGG.fab3.fab3-ncg29-fra3.snmp.gauge.entSensorValue-…``.
    The element right before "snmp" is the device.
    """
    parts = target.split(".")
    try:
        idx = parts.index("snmp")
    except ValueError:
        return ""
    if idx == 0:
        return ""
    return parts[idx - 1]


def _extract_sensor(target: str) -> str:
    for label, suffix in SWITCH_SENSORS:
        if f"module-1__{suffix}" in target:
            return label
    return ""


def _argus_query(expressions: list[str]) -> list[dict[str, Any]]:
    payload = _post_json(ARGUS_PATH, {"expression": expressions})
    return payload.get("data") or []


# --- Colour mapping ---------------------------------------------------------

# mom.dmz uses a green-yellow-red ramp; we match it so the rack tiles
# look familiar.
def _temp_color(temp_c: Optional[float]) -> str:
    if temp_c is None:
        return "rgb(120, 120, 120)"
    if temp_c < 22:
        return "rgb(34, 197, 94)"   # green
    if temp_c < 26:
        return "rgb(132, 204, 22)"  # lime
    if temp_c < 30:
        return "rgb(234, 179, 8)"   # amber
    if temp_c < 34:
        return "rgb(249, 115, 22)"  # orange
    return "rgb(239, 68, 68)"       # red


# --- Public API -------------------------------------------------------------

def _device_temps(*, site: str) -> dict[str, float]:
    """Return ``{device: max_temp_across_sensors}`` for the given site,
    using a short Argus window. Used to colour the rack overview."""
    sensors = [label for label, _ in SWITCH_SENSORS]
    expressions = [
        _build_expression(site=site, sensor=s, timeframe="30m", agg="max")
        for s in sensors
    ]
    raw = _argus_query(expressions)
    out: dict[str, float] = {}
    for item in raw:
        target = item.get("target") or ""
        device = (item.get("tags") or {}).get("device") or _extract_device(target)
        if not device:
            continue
        datapoints = item.get("datapoints") or []
        if not datapoints:
            continue
        # datapoint = [value, unix_ts] — take the most recent.
        last = max(datapoints, key=lambda dp: dp[1] if len(dp) > 1 else 0)
        try:
            value = float(last[0])
        except (TypeError, ValueError):
            continue
        prev = out.get(device)
        if prev is None or value > prev:
            out[device] = value
    return out


def fetch_overview(*, site: str) -> list[Room]:
    """Build the room → rack overview for the requested site.

    Combines:
      * Elasticsearch ``grok-device`` (which device sits in which rack/room)
      * Argus 30-minute max temperature per device

    Each rack's ``tempC`` is the **max** temperature across all switches
    in it, so a single hot device colours the whole tile — matching the
    behaviour of mom.dmz.
    """
    if site not in _SITE_MAP:
        raise MomError(f"unsupported site: {site!r}")
    site_lower, _ = _SITE_MAP[site]

    sources = _fetch_topology(site_lower)
    try:
        device_temps = _device_temps(site=site)
    except MomError as e:
        # Argus glitched but ES worked — show topology with no temps so
        # the user at least sees the rack layout. Logged so we know.
        logger.warning("mom.fetch_overview: argus failed: %s", e)
        device_temps = {}

    # Group ES hits by (room, rack) → list of devices.
    racks_by_room: dict[str, dict[str, list[dict[str, Any]]]] = {}
    rack_meta: dict[tuple[str, str], dict[str, Any]] = {}
    skipped = 0
    for src in sources:
        loc = src.get("asset-location") or {}
        facility = (loc.get("facility") or "").upper()
        if facility != site.upper():
            skipped += 1
            continue
        room = str(loc.get("cage_room") or "").strip()
        rack_label = str(loc.get("rack_number") or "").strip()
        if not room or not rack_label:
            continue
        device = src.get("device")
        if not device:
            continue
        full_value = loc.get("name") or ""
        racks_by_room.setdefault(room, {}).setdefault(rack_label, []).append({
            "device": device,
            "pos": str(loc.get("rackupos_number") or "").strip(),
        })
        meta = rack_meta.setdefault((room, rack_label), {
            "fullValue": full_value,
            "label": rack_label,
            "room": room,
            "cage": rack_label[:1],
        })
        # Prefer a non-empty fullValue once we've seen one.
        if not meta.get("fullValue") and full_value:
            meta["fullValue"] = full_value

    logger.info(
        "mom.fetch_overview site=%s es_hits=%d skipped_other_facility=%d rooms=%d",
        site, len(sources), skipped, len(racks_by_room),
    )

    rooms_out: list[Room] = []
    for room_name in sorted(racks_by_room):
        racks_out: list[Rack] = []
        for rack_label, devices in racks_by_room[room_name].items():
            temps = [
                device_temps[d["device"]]
                for d in devices
                if d["device"] in device_temps
            ]
            max_temp = max(temps) if temps else None
            meta = rack_meta[(room_name, rack_label)]
            racks_out.append({
                "fullValue": meta["fullValue"],
                "label": rack_label,
                "room": room_name,
                "cage": meta["cage"],
                "tempC": round(max_temp, 1) if max_temp is not None else None,
                "color": _temp_color(max_temp),
            })
        racks_out.sort(key=lambda r: r["label"])
        rooms_out.append({"name": room_name, "racks": racks_out})
    return rooms_out


def fetch_rack_devices(*, site: str, rack: str) -> list[Device]:
    """Return all switch devices for the given rack with their current
    max temperature (across sensors).

    ``rack`` is the full asset-location name from the overview
    (e.g. ``"Frankfurt - FRA3 - 14.4 - 424 - E35"``). A bare rack label
    ("E35") is rejected — rack numbers repeat across cage_rooms, so
    filtering on the label alone would mix devices from unrelated rooms
    into the result.
    """
    if site not in _SITE_MAP:
        raise MomError(f"unsupported site: {site!r}")
    site_lower, _ = _SITE_MAP[site]

    rack_norm = (rack or "").strip()
    if " - " not in rack_norm:
        raise MomError(
            f"rack must be the full asset-location name, got {rack!r}"
        )

    sources = _fetch_topology(site_lower)
    try:
        device_temps = _device_temps(site=site)
    except MomError as e:
        logger.warning("mom.fetch_rack_devices: argus failed: %s", e)
        device_temps = {}

    devices: list[Device] = []
    seen: set[str] = set()
    matched_rack = 0
    room_label = ""
    rack_label = ""
    for src in sources:
        loc = src.get("asset-location") or {}
        facility = (loc.get("facility") or "").upper()
        if facility != site.upper():
            continue
        if (loc.get("name") or "").strip() != rack_norm:
            continue
        matched_rack += 1
        # Pick up room/rack labels from the first matching ES hit so we
        # can hand the same coordinates to Coolan. ES carries them
        # canonicalised; the rack name itself is just the human-readable
        # path.
        if not room_label:
            room_label = str(loc.get("cage_room") or "").strip()
        if not rack_label:
            rack_label = str(loc.get("rack_number") or "").strip()
        device = src.get("device")
        if not device or device in seen:
            continue
        seen.add(device)
        temp = device_temps.get(device)
        devices.append({
            "device": device,
            "label": device,
            "pos": str(loc.get("rackupos_number") or "").strip(),
            "tempC": round(temp, 1) if temp is not None else None,
            "color": _temp_color(temp),
            "source": "mom",
        })

    # Append Coolan-known servers in the same rack. Auth/transport
    # failures degrade silently — the user still sees the switches,
    # which is what they had before.
    coolan_count = 0
    if room_label and rack_label:
        try:
            servers = coolan_client.get_rack_servers(
                facility=site.upper(),
                room=room_label,
                rack=rack_label,
            )
        except Exception:
            logger.exception("mom.fetch_rack_devices: coolan lookup failed")
            servers = []
        for s in servers:
            host = (s.get("hostname") or "").strip()
            if not host:
                continue
            # Colour anchor: Inlet temperature, because the green→red
            # ramp is calibrated for rack-air temperatures (matches the
            # mom.dmz switch front sensors). CPU/exhaust are always
            # warmer than inlet by design and would paint every Coolan
            # row red. Fall back through exhaust → cpu only if inlet is
            # missing, so the row is at least coloured something.
            anchor = (s.get("tempInlet") if s.get("tempInlet") is not None
                      else s.get("tempExhaust") if s.get("tempExhaust") is not None
                      else s.get("tempCpuMax"))
            devices.append({
                "device": host,
                "label": host,
                "pos": s.get("u_pos") or "",
                "tempC": round(anchor, 1) if anchor is not None else None,
                "color": _temp_color(anchor),
                "source": "coolan",
                "tempInlet": s.get("tempInlet"),
                "tempExhaust": s.get("tempExhaust"),
                "tempCpuMax": s.get("tempCpuMax"),
                "coolanUuid": s.get("uuid") or "",
            })
            coolan_count += 1

    logger.info(
        "mom.fetch_rack_devices site=%s rack=%r es_hits=%d matched=%d "
        "switches=%d coolan_servers=%d",
        site, rack_norm, len(sources), matched_rack,
        len(seen), coolan_count,
    )
    # Sort by U position numerically when possible; fall back to string
    # so empty/non-numeric values still produce a stable order.
    def _pos_key(d: Device) -> tuple[int, str]:
        raw = (d.get("pos") or "").strip()
        try:
            return (int(raw), raw)
        except ValueError:
            return (10**9, raw)
    devices.sort(key=_pos_key)
    return devices


def fetch_switch_temperatures(
    *,
    site: str,
    sensors: Optional[list[str]] = None,
    timeframe: str = "30m",
    agg: str = "max",
) -> list[Series]:
    """Fetch switch temperature time-series for the given site.

    Returns one Series per (device, sensor) pair. Caller filters/groups.
    """
    if site not in _SITE_MAP:
        raise MomError(f"unsupported site: {site!r}")
    sensor_list = list(sensors) if sensors else [label for label, _ in SWITCH_SENSORS]
    expressions = [
        _build_expression(site=site, sensor=s, timeframe=timeframe, agg=agg)
        for s in sensor_list
    ]
    raw = _argus_query(expressions)
    out: list[Series] = []
    for item in raw:
        target = item.get("target") or ""
        device = (item.get("tags") or {}).get("device") or _extract_device(target)
        sensor = _extract_sensor(target)
        if not device or not sensor:
            continue
        out.append({
            "target": target,
            "device": device,
            "sensor": sensor,
            "datapoints": item.get("datapoints") or [],
        })
    return out


# --- Status / introspection -------------------------------------------------

class MomStatus(TypedDict):
    connected: bool
    savedAt: Optional[str]
    note: str
    lastError: Optional[str]


_last_error: Optional[str] = None


def status() -> MomStatus:
    auth = mom_auth.load()
    return {
        "connected": bool(auth and auth.get("cookie")),
        "savedAt": (auth or {}).get("savedAt"),
        "note": (auth or {}).get("note") or "",
        "lastError": _last_error,
    }


def record_error(msg: Optional[str]) -> None:
    """Surface the last network/auth failure for the status pill."""
    global _last_error
    _last_error = msg


def is_valid_device_name(name: str) -> bool:
    return bool(name and _DEVICE_RE.match(name))
