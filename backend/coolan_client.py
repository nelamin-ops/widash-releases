"""Thin Coolan GraphQL client.

Coolan exposes a Hasura instance at /v1/graphql. The browser SPA carries an
Authorization header and a cookie obtained through SF SSO; we don't have a
service-account token, so the user pastes the browser-side credentials via
``coolan_auth``.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional, TypedDict

import certifi

from . import coolan_auth


def _build_ssl_context() -> ssl.SSLContext:
    """Trust certs Salesforce devices have provisioned via macOS Keychain.

    The Coolan SF-proxy uses an internal CA that's not in certifi's bundle
    but is in the macOS system trust store. On macOS we extract the
    keychain certs once into a cache file and add them to a context
    seeded by certifi (so public CAs still validate too).
    """
    ctx = ssl.create_default_context(cafile=certifi.where())
    if sys.platform != "darwin":
        return ctx
    cache_dir = Path.home() / ".widash"
    cache = cache_dir / "macos_ca_bundle.pem"
    try:
        if not cache.exists():
            cache_dir.mkdir(parents=True, exist_ok=True)
            chunks: list[bytes] = []
            for kc in (
                "/System/Library/Keychains/SystemRootCertificates.keychain",
                "/Library/Keychains/System.keychain",
            ):
                try:
                    out = subprocess.check_output(
                        ["security", "find-certificate", "-a", "-p", kc],
                        timeout=10,
                    )
                    chunks.append(out)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
                        FileNotFoundError):
                    continue
            if chunks:
                cache.write_bytes(b"\n".join(chunks))
                try:
                    os.chmod(cache, 0o600)
                except OSError:
                    pass
        if cache.exists():
            ctx.load_verify_locations(cafile=str(cache))
    except OSError:
        pass
    return ctx


_SSL_CTX = _build_ssl_context()

COOLAN_BASE = (
    "https://coolan.sfproxy.controltelemetry.aws-esvc1-useast2.aws.sfdc.cl"
)
GRAPHQL_PATH = "/v1/graphql"

# Bare UUID, used to validate query inputs before interpolation.
_BARE_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
# Most Coolan links look like:
#   https://coolan.../app/machine/<UUID>/<tab>?...
_MACHINE_UUID_RE = re.compile(
    r"/machine/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


class CoolanStatus(TypedDict):
    connected: bool
    savedAt: Optional[str]
    note: str
    lastError: Optional[str]


def extract_machine_uuid(url: str) -> Optional[str]:
    if not url:
        return None
    match = _MACHINE_UUID_RE.search(url)
    return match.group(1).lower() if match else None


def _build_request(body: dict[str, Any]) -> Optional[urllib.request.Request]:
    auth = coolan_auth.load()
    if not auth:
        return None
    headers = {"Content-Type": "application/json"}
    token = auth.get("token") or ""
    if token:
        headers["Authorization"] = (
            token if token.lower().startswith("bearer ") else f"Bearer {token}"
        )
    cookie = auth.get("cookie") or ""
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(
        COOLAN_BASE + GRAPHQL_PATH,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    return req


def graphql(query: str, variables: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Run a GraphQL query against Coolan/Hasura.

    Raises:
        CoolanAuthError: when no auth is configured or the server rejects
            the request as unauthorized.
        CoolanError: for any other failure.
    """
    req = _build_request({"query": query, "variables": variables or {}})
    if req is None:
        raise CoolanAuthError("no auth configured")
    try:
        with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        if e.code in (401, 403):
            raise CoolanAuthError(f"HTTP {e.code}: {body}") from e
        raise CoolanError(f"HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise CoolanError(f"network error: {e}") from e

    errors = payload.get("errors")
    if errors:
        first = errors[0]
        msg = first.get("message") or "graphql error"
        code = (first.get("extensions") or {}).get("code")
        if code in {"access-denied", "invalid-jwt", "invalid-headers"}:
            raise CoolanAuthError(f"{code}: {msg}")
        raise CoolanError(msg)
    return payload.get("data") or {}


# Map Coolan's raw reporting_state to a UI-friendly bucket.
# Semantics are global: 'active' = host is reporting / alive,
# 'missing' = host is not reporting / unreachable. The UI then paints
# active = green, missing = red. ARCHIVED_* counts as missing because
# the host has been removed from Coolan altogether.
_REPORTING_STATE_MAP = {
    "ACTIVE": "active",
    "DELAYED_REPORTING": "active",
    "ANOMALOUS": "active",
    "MISSING": "missing",
    "ARCHIVED_AUTOMATED": "missing",
    "ARCHIVED_MANUAL": "missing",
}


class CoolanMachine(TypedDict, total=False):
    uuid: str
    state: Optional[str]  # 'missing' | 'active' | None


def get_machine_by_uuid(machine_uuid: str) -> Optional[CoolanMachine]:
    """Return ``{uuid, state}`` for a known UUID, or None on miss/error."""
    try:
        data = graphql(
            "query Q($id: uuid!) { machines_by_pk(id: $id) "
            "{ id reporting_state } }",
            {"id": machine_uuid},
        )
    except CoolanError:
        return None
    machine = data.get("machines_by_pk")
    if not machine:
        return None
    return {
        "uuid": machine.get("id") or machine_uuid,
        "state": _REPORTING_STATE_MAP.get(machine.get("reporting_state")),
    }


def get_machines_by_uuids(uuids: list[str]) -> dict[str, CoolanMachine]:
    """Batched ``get_machine_by_uuid``: one GraphQL call for many uuids.

    Returns ``{uuid: {uuid, state}}`` for every uuid present in Coolan;
    missing uuids are simply absent from the dict. Invalid uuids are
    filtered out before the call.
    """
    valid = [u for u in uuids if u and _BARE_UUID_RE.match(u)]
    if not valid:
        return {}
    try:
        data = graphql(
            "query Q($ids: [uuid!]!) { "
            "machines(where: {id: {_in: $ids}}) "
            "{ id reporting_state } }",
            {"ids": valid},
        )
    except CoolanError:
        return {}
    out: dict[str, CoolanMachine] = {}
    for m in data.get("machines") or []:
        uid = m.get("id")
        if not uid:
            continue
        out[uid] = {
            "uuid": uid,
            "state": _REPORTING_STATE_MAP.get(m.get("reporting_state")),
        }
    return out


def get_machines_by_search_batch(
    asset_names: list[str],
) -> dict[str, CoolanMachine]:
    """Batched serial / hostname lookup for many tickets at once.

    Same shape semantics as ``get_machine_by_search`` (the report's
    ``"<asset_tag> / <serial> / <hostname>"`` format), but issues a
    single Hasura ``_or`` query that matches any of the serials or
    hostnames. Returns ``{asset_name: machine}`` so the caller can
    map results back to the originating ticket cheaply.
    """
    needles_by_name: dict[str, tuple[str, str]] = {}
    serials: set[str] = set()
    hostnames: set[str] = set()
    for name in asset_names:
        if not name:
            continue
        parts = [p.strip() for p in name.split("/") if p.strip()]
        serial = parts[1] if len(parts) >= 2 else ""
        hostname = parts[-1] if parts else ""
        needles_by_name[name] = (serial, hostname)
        if serial: serials.add(serial)
        if hostname: hostnames.add(hostname)

    if not serials and not hostnames:
        return {}
    or_clauses: list[str] = []
    variables: dict[str, Any] = {}
    if serials:
        or_clauses.append("{serial_number: {_in: $serials}}")
        variables["serials"] = sorted(serials)
    if hostnames:
        or_clauses.append("{hostname: {_in: $hostnames}}")
        variables["hostnames"] = sorted(hostnames)
    var_decl = ", ".join(
        ([f"$serials: [String!]"] if serials else []) +
        ([f"$hostnames: [String!]"] if hostnames else [])
    )
    try:
        data = graphql(
            f"query Q({var_decl}) {{ "
            f"machines(where: {{_or: [{', '.join(or_clauses)}]}}, limit: 500) "
            f"{{ id serial_number hostname reporting_state }} }}",
            variables,
        )
    except CoolanError:
        return {}
    by_serial: dict[str, dict] = {}
    by_hostname: dict[str, dict] = {}
    for m in data.get("machines") or []:
        s = (m.get("serial_number") or "").strip()
        h = (m.get("hostname") or "").strip()
        if s and s not in by_serial:
            by_serial[s] = m
        if h and h not in by_hostname:
            by_hostname[h] = m

    out: dict[str, CoolanMachine] = {}
    for name, (serial, hostname) in needles_by_name.items():
        m = (by_serial.get(serial) if serial else None) \
            or (by_hostname.get(hostname) if hostname else None)
        if not m:
            continue
        out[name] = {
            "uuid": m.get("id") or "",
            "state": _REPORTING_STATE_MAP.get(m.get("reporting_state")),
        }
    return out


def get_machine_by_search(asset_name: str) -> Optional[CoolanMachine]:
    """Best-effort lookup when the case has no Coolan link.

    The SF report's asset name is shaped as
    ``"<asset_tag> / <serial_number> / <hostname>"`` — we try the serial
    first because it's the most stable key in Coolan, and fall back to
    the hostname fragment if serial-search misses.
    """
    if not asset_name:
        return None
    parts = [p.strip() for p in asset_name.split("/") if p.strip()]
    serial = parts[1] if len(parts) >= 2 else ""
    hostname_fragment = parts[-1] if parts else ""

    needles: list[tuple[str, str]] = []  # (where_field, value)
    if serial:
        needles.append(("serial_number", serial))
    if hostname_fragment:
        needles.append(("hostname", hostname_fragment))

    for field, value in needles:
        try:
            data = graphql(
                f"query Q($q: String!) {{ machines("
                f"where: {{{field}: {{_ilike: $q}}}}, limit: 1) "
                "{ id reporting_state } }",
                {"q": f"%{value}%"},
            )
        except CoolanError:
            continue
        rows = data.get("machines") or []
        if rows:
            return {
                "uuid": rows[0].get("id") or "",
                "state": _REPORTING_STATE_MAP.get(rows[0].get("reporting_state")),
            }
    return None


class CoolanComponentAttribute(TypedDict):
    key: str       # short label shown in the UI ("Capacity")
    value: str     # parsed string value as Coolan reports it


class CoolanComponent(TypedDict):
    asset_type: str
    display_name: str
    reporting_state: str
    last_report_time: Optional[str]
    # Aggregated health condition from component_health_indicator_summary —
    # only meaningful when reporting_state == ACTIVE. Examples seen in the
    # wild: DEGRADED, NORMAL. The UI surfaces this as a softer "warning"
    # state between active-and-fine and removed-and-gone.
    health_condition: Optional[str]
    # Effective state used for colouring: reporting_state if not ACTIVE,
    # otherwise health_condition; falls back to reporting_state when neither
    # produces something interesting.
    effective_state: str
    # Curated list of details (Vendor / Serial / Capacity / Slot etc.)
    # derived per asset_type from component_attributes. Empty when none
    # of the interesting attributes are present.
    attributes: list[CoolanComponentAttribute]


# Per-asset-type whitelist of (label, attribute names to look at). The
# first non-empty parsed_value wins so a single label can fall back to
# a sibling attribute name. Anything with a "Description" suffix in
# Coolan often duplicates the bare attribute, so we normalise here.
_ATTR_KEYS_BY_ASSET: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "DRIVE": (
        ("Vendor", ("vendorName",)),
        ("Model", ("modelNumber", "vendorModelNumber")),
        ("Serial", ("serialNumber",)),
        ("Capacity", ("capacity",)),
        ("Form factor", ("formFactor",)),
        ("Drive type", ("inferredDriveType",)),
        ("Rotation", ("rotationRate",)),
        ("Firmware", ("firmwareVersion",)),
        ("Slot / device", ("deviceName",)),
        ("SMART status", ("smartHealthStatus",)),
        ("RAID", ("mdadmStatus", "swRaidConnectionHealth")),
        ("WWN", ("wwn",)),
    ),
    "MEMORY": (
        ("Vendor", ("vendorName", "manufacturer")),
        ("Model", ("partNumber", "modelNumber")),
        ("Serial", ("serialNumber",)),
        ("Capacity", ("capacity", "size")),
        ("Speed", ("speed",)),
        ("Type", ("memoryType",)),
        ("Slot", ("locator", "deviceLocator", "bankLocator")),
    ),
    "PSU": (
        ("Vendor", ("vendorName", "manufacturer")),
        ("Model", ("partNumber", "modelNumber")),
        ("Serial", ("serialNumber",)),
        ("Power", ("maxOutputWattage", "power")),
        ("Slot", ("locator",)),
    ),
    "FAN": (
        ("Slot", ("locator",)),
        ("Speed", ("speed", "rpm")),
        ("Status", ("status",)),
    ),
    "PROCESSOR": (
        ("Vendor", ("vendorName", "manufacturer")),
        ("Model", ("modelName", "modelNumber")),
        ("Cores", ("coreCount",)),
        ("Speed", ("speed", "currentSpeed")),
        ("Socket", ("socket",)),
    ),
    "NETWORKINTERFACE": (
        ("Vendor", ("vendorName",)),
        ("Model", ("modelNumber",)),
        ("MAC", ("macAddress",)),
        ("Speed", ("speed", "linkSpeed")),
        ("Driver", ("driver",)),
        ("PCI", ("pciAddress",)),
    ),
    "OOBNETWORKINTERFACE": (
        ("MAC", ("macAddress",)),
        ("IP", ("ipAddress",)),
        ("Speed", ("speed",)),
    ),
    "RAIDCARD": (
        ("Vendor", ("vendorName",)),
        ("Model", ("modelNumber",)),
        ("Firmware", ("firmwareVersion",)),
        ("Driver", ("driver",)),
    ),
    "BMC": (
        ("Vendor", ("vendorName",)),
        ("Firmware", ("firmwareVersion",)),
        ("MAC", ("macAddress",)),
    ),
    "BIOS": (
        ("Vendor", ("vendorName",)),
        ("Version", ("version", "firmwareVersion")),
        ("Date", ("releaseDate",)),
    ),
    "MOTHERBOARD": (
        ("Vendor", ("vendorName", "manufacturer")),
        ("Model", ("modelNumber", "productName")),
        ("Serial", ("serialNumber",)),
    ),
    "CHASSIS": (
        ("Vendor", ("vendorName", "manufacturer")),
        ("Model", ("modelNumber", "productName")),
        ("Serial", ("serialNumber",)),
    ),
    "TEMPERATURE_PROBE": (
        ("Reading", ("reading", "currentReading")),
        ("Slot", ("locator",)),
        ("Status", ("status",)),
    ),
    "VOLUME": (
        ("Mount", ("mountpoint",)),
        ("Filesystem", ("filesystem",)),
        ("Capacity", ("size", "capacity")),
        ("Used", ("usedBytes",)),
    ),
    "SOFTWARE_RAID_ARRAY": (
        ("Level", ("raidLevel",)),
        ("State", ("arrayState",)),
        ("Members", ("memberCount",)),
    ),
}


def _curated_attributes(
    asset_type: str, raw_attrs: list[dict],
) -> list[CoolanComponentAttribute]:
    """Project Coolan's free-form component_attributes onto the small
    set of fields a tech actually needs while diagnosing an RMA."""
    spec = _ATTR_KEYS_BY_ASSET.get(asset_type)
    if not spec:
        return []
    by_name: dict[str, str] = {}
    for a in raw_attrs:
        n = a.get("name")
        v = a.get("parsed_value")
        if not n or not v:
            continue
        by_name.setdefault(n, str(v))
    out: list[CoolanComponentAttribute] = []
    for label, names in spec:
        for n in names:
            v = by_name.get(n)
            if v:
                out.append({"key": label, "value": v})
                break
    return out


# Coolan's own UI prefers the reporting_state when a component has been
# removed/missing (no health data is generated there); for active
# components it surfaces the worst tool-determined condition. We mirror
# that priority here.
# Health values that don't need to be flagged. UNKNOWN means Coolan
# doesn't have indicator data for the component (e.g. volumes), not that
# something is wrong, so we don't treat it as an alert.
_HEALTHY_CONDITIONS = {"NORMAL", "OK", "HEALTHY", "UNKNOWN"}


def _effective_state(reporting_state: str, health_condition: Optional[str]) -> str:
    if reporting_state and reporting_state != "ACTIVE":
        return reporting_state
    if health_condition and health_condition not in _HEALTHY_CONDITIONS:
        return health_condition
    return reporting_state or "UNKNOWN"


def get_components(machine_uuid: str, limit: int = 200) -> list[CoolanComponent]:
    """Return the components attached to a Coolan machine.

    Sorted with unhealthy entries first (anything not ACTIVE / NORMAL),
    then by asset_type, then by display_name. The UI renders them grouped.
    """
    if not _BARE_UUID_RE.match(machine_uuid or ""):
        return []
    soql = """
      query M($id: uuid!, $limit: Int!) {
        components(
          where: {parent_machine_id: {_eq: $id}}
          limit: $limit
          order_by: [{asset_type: asc}, {display_name: asc}]
        ) {
          asset_type display_name reporting_state last_report_time
          component_health_indicator_summary {
            worst_tool_determined_condition
          }
          component_attributes(limit: 80) {
            name parsed_value
          }
        }
      }
    """
    try:
        data = graphql(soql, {"id": machine_uuid, "limit": limit})
    except CoolanError:
        return []
    rows_raw = data.get("components") or []
    out: list[CoolanComponent] = []
    for r in rows_raw:
        summary = r.get("component_health_indicator_summary") or {}
        health = summary.get("worst_tool_determined_condition") or None
        rs = r.get("reporting_state") or ""
        asset_type = r.get("asset_type") or ""
        out.append({
            "asset_type": asset_type,
            "display_name": r.get("display_name") or "",
            "reporting_state": rs,
            "last_report_time": r.get("last_report_time"),
            "health_condition": health,
            "effective_state": _effective_state(rs, health),
            "attributes": _curated_attributes(
                asset_type, r.get("component_attributes") or [],
            ),
        })
    # Unhealthy first, then by type / name.
    def _is_healthy(c: CoolanComponent) -> bool:
        return c["effective_state"] == "ACTIVE"
    out.sort(key=lambda c: (
        0 if not _is_healthy(c) else 1,
        c.get("asset_type") or "",
        c.get("display_name") or "",
    ))
    return out


class CoolanRackServer(TypedDict, total=False):
    uuid: str
    hostname: str
    u_pos: str
    # Inlet / Exhaust / max(CPU) in °C. None when the probe is missing
    # or its parsed_value can't be coerced to float.
    tempInlet: Optional[float]
    tempExhaust: Optional[float]
    tempCpuMax: Optional[float]
    last_report_time: Optional[str]
    reporting_state: Optional[str]


# 30-minute cache. Coolan refreshes server data hourly, so the rack-server
# list barely moves and a cold lookup costs one Hasura query — keeping the
# UI snappy when the user clicks back and forth between racks.
_rack_servers_cache: dict[tuple[str, str, str], tuple[float, list["CoolanRackServer"]]] = {}
_RACK_SERVERS_TTL_S = 1800.0

# Allow-list shapes that mom.dmz produces. Coolan's RACK_TECH_ASSET
# attributes carry these as plain strings; we never interpolate them
# into the GraphQL string (the query uses a single parameterised
# `$attrs: jsonb` variable), but the regex defends against weird inputs
# leaking into the cache key or telemetry.
_RACK_FACILITY_RE = re.compile(r"^[A-Z]{2,4}\d$")
_RACK_ROOM_RE = re.compile(r"^[A-Za-z0-9]{1,8}$")
_RACK_LABEL_RE = re.compile(r"^[A-Za-z0-9]{1,8}$")


def get_rack_servers(
    *, facility: str, room: str, rack: str,
) -> list["CoolanRackServer"]:
    """Return Coolan-known servers in the given rack with temperature probes.

    Filters Coolan's machines by their ``RACK_TECH_ASSET`` external-record
    attributes ``{Facility, Room, RackNumber}``. Each result carries the
    server's U-position plus Inlet / Exhaust / max-CPU temperatures —
    Coolan has no machine-level aggregate, so we read the individual
    ``TEMPERATURE_PROBE`` components and pick known display names.
    """
    import time as _time
    f = (facility or "").strip().upper()
    r = (room or "").strip()
    k = (rack or "").strip().upper()
    if not (_RACK_FACILITY_RE.match(f)
            and _RACK_ROOM_RE.match(r)
            and _RACK_LABEL_RE.match(k)):
        return []

    now = _time.time()
    cached = _rack_servers_cache.get((f, r, k))
    if cached and now - cached[0] < _RACK_SERVERS_TTL_S:
        return cached[1]

    query = """
      query Q($attrs: jsonb!) {
        machines(
          where: {
            machine_external_records: {
              external_record: {
                record_type: {_eq: "RACK_TECH_ASSET"},
                attributes: {_contains: $attrs}
              }
            }
          }
          limit: 200
        ) {
          id hostname reporting_state last_report_time
          machine_attributes(
            where: {name: {_eq: "rackUPositionFromBottom"}}
            limit: 1
          ) { name parsed_value }
          components(
            where: {
              asset_type: {_eq: "TEMPERATURE_PROBE"},
              reporting_state: {_eq: "ACTIVE"}
            }
            limit: 30
          ) {
            display_name
            component_attributes(limit: 20) { name parsed_value }
          }
        }
      }
    """
    try:
        data = graphql(
            query,
            {"attrs": {"Facility": f, "Room": r, "RackNumber": k}},
        )
    except CoolanError:
        return []

    out: list[CoolanRackServer] = []
    for m in data.get("machines") or []:
        u_pos = ""
        for ma in m.get("machine_attributes") or []:
            if ma.get("name") == "rackUPositionFromBottom":
                u_pos = str(ma.get("parsed_value") or "").strip()
                break
        inlet: Optional[float] = None
        exhaust: Optional[float] = None
        cpu_max: Optional[float] = None
        for comp in m.get("components") or []:
            display = (comp.get("display_name") or "").strip()
            value: Optional[float] = None
            # Probes carry exactly one *Temperature attribute, e.g.
            # "inletTemperature" / "cpu1Temperature" — find it and parse.
            for ca in comp.get("component_attributes") or []:
                name = ca.get("name") or ""
                if name.endswith("Temperature"):
                    try:
                        value = float(ca.get("parsed_value") or "")
                    except (TypeError, ValueError):
                        value = None
                    break
            if value is None:
                continue
            if display == "Inlet Temp":
                inlet = value
            elif display == "Exhaust Temp":
                exhaust = value
            elif display.startswith("CPU "):
                if cpu_max is None or value > cpu_max:
                    cpu_max = value
        out.append({
            "uuid": m.get("id") or "",
            "hostname": m.get("hostname") or "",
            "u_pos": u_pos,
            "tempInlet": inlet,
            "tempExhaust": exhaust,
            "tempCpuMax": cpu_max,
            "last_report_time": m.get("last_report_time"),
            "reporting_state": m.get("reporting_state"),
        })

    _rack_servers_cache[(f, r, k)] = (now, out)
    return out


class CoolanTempProbe(TypedDict, total=False):
    name: str           # "Inlet Temp", "CPU 1 Temp", "Exhaust Temp", …
    tempC: Optional[float]
    last_report_time: Optional[str]


class CoolanTempSnapshot(TypedDict):
    uuid: str
    hostname: str
    probes: list[CoolanTempProbe]
    last_report_time: Optional[str]
    machine_url: str


def get_machine_temp_snapshot(machine_uuid: str) -> Optional[CoolanTempSnapshot]:
    """Return all active TEMPERATURE_PROBE readings for one Coolan machine.

    Used by the rack overlay's per-server detail panel. Coolan has no
    historical time-series for sensor data, so we surface the snapshot
    instead of a chart.
    """
    if not _BARE_UUID_RE.match(machine_uuid or ""):
        return None
    query = """
      query Q($id: uuid!) {
        machines_by_pk(id: $id) {
          id hostname last_report_time
          components(
            where: {
              asset_type: {_eq: "TEMPERATURE_PROBE"},
              reporting_state: {_eq: "ACTIVE"}
            }
            limit: 30
          ) {
            display_name last_report_time
            component_attributes(limit: 20) { name parsed_value }
          }
        }
      }
    """
    try:
        data = graphql(query, {"id": machine_uuid})
    except CoolanError:
        return None
    m = data.get("machines_by_pk")
    if not m:
        return None
    probes: list[CoolanTempProbe] = []
    for comp in m.get("components") or []:
        value: Optional[float] = None
        for ca in comp.get("component_attributes") or []:
            if (ca.get("name") or "").endswith("Temperature"):
                try:
                    value = float(ca.get("parsed_value") or "")
                except (TypeError, ValueError):
                    value = None
                break
        probes.append({
            "name": (comp.get("display_name") or "").strip(),
            "tempC": value,
            "last_report_time": comp.get("last_report_time"),
        })
    # Sort with Inlet/Exhaust first (the "rack air" pair), then CPUs by
    # numeric suffix, then everything else alphabetically — mirrors the
    # order an engineer scans them in.
    def _key(p: CoolanTempProbe) -> tuple[int, str]:
        n = p.get("name") or ""
        if n == "Inlet Temp": return (0, n)
        if n == "Exhaust Temp": return (1, n)
        if n.startswith("CPU "): return (2, n)
        return (3, n)
    probes.sort(key=_key)
    return {
        "uuid": m.get("id") or machine_uuid,
        "hostname": m.get("hostname") or "",
        "probes": probes,
        "last_report_time": m.get("last_report_time"),
        "machine_url": f"{COOLAN_BASE}/app/machine/{m.get('id') or machine_uuid}/summary",
    }


def synthesize_links(machine_uuid: str) -> list[dict[str, str]]:
    """Build the standard three Coolan-tab links for a machine UUID.

    Order matches the link-list parsed from Description: Components first
    (most useful for the engineer triaging the case), then Machine summary,
    then Logs.
    """
    base = f"{COOLAN_BASE}/app/machine/{machine_uuid}"
    return [
        {"title": "Components", "url": f"{base}/components?showUnhealthy=true"},
        {"title": "Machine", "url": f"{base}/summary"},
        {"title": "Logs", "url": f"{base}/logfiles"},
    ]


def status() -> CoolanStatus:
    auth = coolan_auth.load()
    if not auth:
        return {
            "connected": False,
            "savedAt": None,
            "note": "",
            "lastError": "no auth configured",
        }
    # Cheap probe: introspect the Query type. If Hasura answers, we're good.
    try:
        graphql("{ __schema { queryType { name } } }")
    except CoolanAuthError as e:
        return {
            "connected": False,
            "savedAt": auth.get("savedAt"),
            "note": auth.get("note", ""),
            "lastError": str(e),
        }
    except CoolanError as e:
        return {
            "connected": False,
            "savedAt": auth.get("savedAt"),
            "note": auth.get("note", ""),
            "lastError": str(e),
        }
    return {
        "connected": True,
        "savedAt": auth.get("savedAt"),
        "note": auth.get("note", ""),
        "lastError": None,
    }


class CoolanError(Exception):
    """Generic Coolan client error."""


class CoolanAuthError(CoolanError):
    """The Coolan API rejected the saved auth (401/403/access-denied)."""
