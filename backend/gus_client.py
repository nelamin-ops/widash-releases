import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from simple_salesforce import Salesforce
from simple_salesforce.exceptions import SalesforceError, SalesforceExpiredSession

logger = logging.getLogger("widash.gus")


def install_connection_retry(sf: Salesforce) -> None:
    """Make the simple_salesforce HTTP session retry once on idle-pool
    disconnects.

    Salesforce closes idle TCP connections after a few minutes; the
    next query in the same session sees "RemoteDisconnected" and
    surfaces as a 500 to the frontend. urllib3's built-in retry covers
    transport-level failures (which RemoteDisconnected counts as) and
    transparently opens a fresh connection. Without this we'd need
    per-callsite try/except in every endpoint.
    """
    try:
        from urllib3.util.retry import Retry
        from requests.adapters import HTTPAdapter
        retry = Retry(
            total=2, connect=2, read=2,
            status=0, redirect=0,
            backoff_factor=0.3,
            allowed_methods=frozenset(["GET", "POST", "PATCH", "PUT", "DELETE"]),
            # Treat 502/503/504 as retryable — these are transient SF
            # gateway hiccups, not real failures.
            status_forcelist=(502, 503, 504),
        )
        adapter = HTTPAdapter(max_retries=retry)
        sf.session.mount("http://", adapter)
        sf.session.mount("https://", adapter)
    except Exception:  # noqa: BLE001
        logger.exception("install_connection_retry failed; continuing without")
from . import coolan_client
from .models import (
    CoolanLink,
    DetailsBlock,
    DetailsSegment,
    MyRtsTicket,
    PrioBreakdown,
    RmaActiveResponse,
    RmaTicket,
    StatusBucket,
    WorkItem,
    WorkItemDetail,
    WorkItemHistoryEvent,
)

# Salesforce 15- or 18-character record IDs are alphanumeric only. The IDs we
# pass into SOQL all originate from authenticated SF responses today, but this
# guard keeps the f-string interpolation safe if a future code path ever feeds
# an unvalidated value into _query_history / _query_feed / _query_active_case_ids.
_SF_ID_RE = re.compile(r"^[a-zA-Z0-9]{15,20}$")

# Site tokens / prefixes that the work-item query interpolates into a
# SOQL LIKE clause. They come from the active report's own location
# values, but get re-validated here before touching the query string so
# a malformed report row can never widen the SOQL surface. A token is a
# site code like "FRA3" / "CDG1A"; a prefix is the bare region like
# "FRA" / "CDG".
_SITE_TOKEN_RE = re.compile(r"^[A-Z]{2,4}[0-9]{0,3}[A-Z]?$")
_SITE_PREFIX_RE = re.compile(r"^[A-Z]{2,4}$")

# GUS work-item id ("W-23124643"). Used to allow-list the work-item
# detail lookup before the value reaches SOQL.
_WORK_ID_RE = re.compile(r"^W-[0-9]{4,12}$")


def _safe_ids_clause(ids: list[str]) -> str:
    safe = [i for i in ids if _SF_ID_RE.match(i)]
    return ",".join(f"'{i}'" for i in safe)

# Default report — Frankfurt RMAs. Frontend can override per-request via
# the X-Report-Id header so the same backend serves users from any site.
DEFAULT_REPORT_ID = "00OEE000001HkkD2AS"

# Curated map of region prefix -> known report id. New regions get added
# here (one-time effort by whoever builds the report in GUS); everyone
# in that region then auto-resolves with no setup.
SITE_REPORTS: dict[str, str] = {
    "FRA": "00OEE000001HkkD2AS",  # Frankfurt RMAs
}

# Status colors for the actual report statuses (Frankfurt RMAs).
# Tailwind-style scale, intentionally distinct so the donut + tab + sheet
# header colour never collide between statuses. Pending Triage and
# Pending Drain are kept on different hues (lime vs. amber) so the two
# "yellowish" buckets are not confused at a glance.
STATUS_COLORS = {
    "New": "#94A3B8",                        # slate-400
    "Pending Triage": "#A3E635",             # lime-400  (yellow-green)
    "Pending Drain": "#F59E0B",              # amber-500 (saturated amber)
    "Drain Scheduled": "#38BDF8",            # sky-400
    "Drained": "#22D3EE",                    # cyan-400
    "Remediating": "#818CF8",                # indigo-400
    "Waiting for Internal Party": "#C084FC", # purple-400
    "Waiting for External Party": "#F472B6", # pink-400
    "Return to Service": "#34D399",          # emerald-400
    "HW Repaired": "#2DD4BF",                # teal-400
    "Closed": "#6B7280",                     # gray-500
    "Closed - Duplicate": "#4B5563",         # gray-600
    "Escalated": "#F87171",                  # red-400
}

# Severity values come straight from the report (Sev0…Sev5). We expose them
# as-is rather than mapping to a P0–P3 schema — Sev0 is highest, Sev5 lowest.
ALL_SEVERITIES = ("Sev0", "Sev1", "Sev2", "Sev3", "Sev4", "Sev5")

# Username prefixes for service accounts whose chatter is too noisy to
# surface in the activity log. Per region these look like
# ``svc_grok-fra@gus.com`` / ``svc_grok-cdg@gus.com`` etc., so we match
# on the common prefix instead of one explicit address per region.
NOISE_ACTOR_PREFIXES = ("svc_grok-",)


def _is_noise_actor(actor: str | None) -> bool:
    a = (actor or "").lower()
    return any(a.startswith(p) for p in NOISE_ACTOR_PREFIXES)

# Detail-column indices in the report response (must match the report's
# `detailColumns` order — see report metadata).
COL_CASE_NUMBER = 0     # CASE_NUMBER (label = number, value = SF Id)
COL_AGE = 1             # AGE in days (int)
COL_PRIORITY = 2        # Sev3 / Sev4 / Sev5
COL_FK_NAME = 5         # asset tag / serial
COL_ASSET_LOCATION = 6  # "Frankfurt - FRA3 - 14.1 - 124 - F10"
COL_OWNER = 7           # owner / assignee group
COL_SUBJECT = 9         # subject ("[Coolan 2.0] ...")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# Extract @-mention plain text from Chatter <a class="cuf-userlink">…</a> spans
# so mention-detection still works after we strip HTML.
_MENTION_LINK_RE = re.compile(
    r'<a[^>]*class="[^"]*cuf-userlink[^"]*"[^>]*>([^<]+)</a>',
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
import html as _html
from html.parser import HTMLParser as _HTMLParser


def _strip_html(text: str) -> str:
    """Convert Chatter HTML to plain text, preserving @mentions as @Name."""
    if not text:
        return ""
    # Turn user-link anchors into "@Name" so the mention-needle scan still works.
    text = _MENTION_LINK_RE.sub(lambda m: f"@{m.group(1).strip()}", text)
    text = _TAG_RE.sub("", text)
    text = _html.unescape(text)
    return " ".join(text.split())


# Heading tags collapse to a single "h" block kind (we don't need h1..h6
# levels in the sheet); list/table tags drive their own block kinds.
_DETAILS_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

# Embedded chatter/feed images reference a Salesforce ContentDocument by
# id ("sfdc://069…"). We only ever accept that exact shape — the id is
# allow-listed here and again at the proxy endpoint before it touches SF.
_SFDC_IMG_RE = re.compile(r"^sfdc://(069[A-Za-z0-9]{12,15})$", re.IGNORECASE)


class _DetailsParser(_HTMLParser):
    """Parse Details__c HTML into structured blocks of inline segments.

    GUS work items carry real rich-text here — paragraphs, headings,
    bullet/numbered lists, and big asset *tables* (40+ rows). We emit our
    own structured model (blocks → segments, text + validated http/https
    link + bold) rather than passing HTML to the browser; the standing
    rule is the frontend never trusts backend HTML. Anchors with a
    non-http(s) href (``javascript:`` / ``data:`` / relative) degrade to
    plain text so a hostile link can't smuggle a scheme to the click layer.

    The parser is a small state machine: a current block accumulates
    inline segments; list and table tags open/close nested containers
    (list items, table rows, table cells). Unknown/decorative tags
    (``span``, ``br``, ``strong``…) only toggle inline state, never
    structure, so malformed nesting degrades gracefully instead of
    raising.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict] = []
        self._cur: Optional[dict] = None     # current block being built
        self._href: str = ""
        self._bold = 0                       # nesting depth of bold tags
        # Table state: list[row] where row is list[cell] and cell is
        # list[segment]; plus the cell currently receiving text.
        self._table: Optional[list] = None
        self._row: Optional[list] = None
        self._cell: Optional[list] = None

    # -- helpers ---------------------------------------------------------
    def _open(self, kind: str) -> None:
        self._cur = {"kind": kind, "segments": [], "items": [], "rows": []}

    def _close(self) -> None:
        if self._cur and (
            self._cur["segments"] or self._cur["items"] or self._cur["rows"]
        ):
            self.blocks.append(self._cur)
        self._cur = None

    def _sink(self) -> Optional[list]:
        """Where inline text currently lands: a table cell, the open list
        item, or the current block's segment list."""
        if self._cell is not None:
            return self._cell
        if self._cur is None:
            return None
        if self._cur["kind"] in ("ul", "ol") and self._cur["items"]:
            return self._cur["items"][-1]
        return self._cur["segments"]

    # -- HTMLParser hooks ------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if tag in ("p", "div"):
            self._close(); self._open("p")
        elif tag in _DETAILS_HEADINGS:
            self._close(); self._open("h")
        elif tag in ("ul", "ol"):
            self._close(); self._open(tag)
        elif tag == "li":
            if self._cur and self._cur["kind"] in ("ul", "ol"):
                self._cur["items"].append([])
        elif tag == "table":
            self._close(); self._open("table"); self._table = self._cur["rows"]
        elif tag == "tr" and self._table is not None:
            self._row = []
            self._table.append(self._row)
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._row.append(self._cell)
        elif tag == "a":
            href = (dict(attrs).get("href") or "").strip()
            low = href.lower()
            self._href = href if (
                low.startswith("http://") or low.startswith("https://")
            ) else ""
        elif tag == "img":
            # Embedded chatter image — keep only the whitelisted
            # sfdc://069… ContentDocument reference; anything else (data:,
            # http:, on-error handlers) is dropped, never rendered.
            src = (dict(attrs).get("src") or "").strip()
            alt = (dict(attrs).get("alt") or "").strip()
            m = _SFDC_IMG_RE.match(src)
            if m:
                sink = self._sink()
                if sink is None:
                    self._open("p")
                    sink = self._cur["segments"]
                sink.append({
                    "text": alt, "href": "", "bold": False,
                    "imageId": m.group(1),
                })
        elif tag in ("strong", "b"):
            self._bold += 1

    def handle_endtag(self, tag):
        if tag == "a":
            self._href = ""
        elif tag in ("strong", "b"):
            self._bold = max(0, self._bold - 1)
        elif tag in ("td", "th"):
            self._cell = None
        elif tag == "tr":
            self._row = None
        elif tag == "table":
            self._table = None
            self._close()
        elif tag in ("p", "div", "ul", "ol") + tuple(_DETAILS_HEADINGS):
            self._close()

    def handle_data(self, data):
        text = data.strip()
        if not text:
            return
        sink = self._sink()
        if sink is None:
            self._open("p")
            sink = self._cur["segments"]
        sink.append({
            "text": text, "href": self._href,
            "bold": bool(self._bold), "imageId": "",
        })

    def result(self) -> list[dict]:
        self._close()
        return self.blocks


def _parse_details(raw: str) -> tuple[str, list[dict]]:
    """Return (plain_text, structured_blocks) for a Details__c value.

    The flattened plain text feeds chat/search; the blocks feed the
    sheet's rich rendering. Falls back to a single plain paragraph if the
    parser ever chokes — the field must never blank the sheet."""
    if not raw:
        return "", []
    try:
        p = _DetailsParser()
        p.feed(raw)
        blocks = p.result()
    except Exception:
        logger.exception("details parse failed")
        flat = _strip_html(raw)
        return flat, (
            [{"kind": "p",
              "segments": [{"text": flat, "href": "", "bold": False, "imageId": ""}],
              "items": [], "rows": []}] if flat else []
        )

    def _texts(block: dict):
        yield from (s["text"] for s in block["segments"])
        for item in block["items"]:
            yield from (s["text"] for s in item)
        for row in block["rows"]:
            for cell in row:
                yield from (s["text"] for s in cell)

    plain = " ".join(t for b in blocks for t in _texts(b))
    return plain, blocks


def _seg(s: dict) -> DetailsSegment:
    return DetailsSegment(
        text=s["text"], href=s.get("href") or "", bold=bool(s.get("bold")),
        imageId=s.get("imageId") or "",
    )


def _details_block(b: dict) -> DetailsBlock:
    """Convert one parser dict into the DetailsBlock response model."""
    return DetailsBlock(
        kind=b["kind"],
        segments=[_seg(s) for s in b["segments"]],
        items=[[_seg(s) for s in item] for item in b["items"]],
        rows=[[[_seg(s) for s in cell] for cell in row] for row in b["rows"]],
    )


def _walk_leaf_keys(groupings: list, path: list[str]) -> dict[str, tuple[str, ...]]:
    """Walk the report's grouping tree and return {factMap_key: (location, rack, status, ...)}."""
    out: dict[str, tuple[str, ...]] = {}
    for node in groupings:
        new_path = path + [node.get("label", "")]
        sub = node.get("groupings") or []
        if not sub:
            out[node["key"] + "!T"] = tuple(new_path)
        else:
            out.update(_walk_leaf_keys(sub, new_path))
    return out


class GusClient:
    def __init__(
        self,
        sf: Optional[Salesforce] = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        report_id: str = DEFAULT_REPORT_ID,
    ):
        self._sf = sf
        self._now = now
        self._report_id = report_id
        self._cached_rows: list[dict] = []
        self._active_case_ids_cache: list[str] = []
        # case_id -> data center facility ("FRA1" / "CDG2" / multi)
        self._facility_by_case_id: dict[str, str] = {}
        # Wall-clock seconds at which the case-ids cache was populated.
        # 0 means "no cache yet". Used to expire the cache on its own
        # (independent of /api/refresh) so a case that just transitioned
        # out of LAST_N_DAYS:14 isn't missed by the RTS-today counter or
        # the activity log.
        self._active_case_ids_cached_at: float = 0.0
        self._user_id_cache: Optional[str] = None
        self._user_info_cache: Optional[dict] = None

    def _fetch_rows(self) -> list[dict]:
        payload = self._sf.restful(
            f"analytics/reports/{self._report_id}?includeDetails=true",
            method="GET",
        )
        fact_map = payload["factMap"]
        leaf_meta = _walk_leaf_keys(
            payload.get("groupingsDown", {}).get("groupings", []), []
        )

        now = self._now()
        parsed: list[dict] = []
        for key, meta in leaf_meta.items():
            location = meta[0] if len(meta) >= 1 else ""
            status = meta[2] if len(meta) >= 3 else ""
            rack = meta[1] if len(meta) >= 2 else ""
            for row in fact_map.get(key, {}).get("rows", []):
                cells = row["dataCells"]
                age_days = cells[COL_AGE].get("value") or 0
                created = now - timedelta(days=int(age_days))
                sev = cells[COL_PRIORITY].get("value") or ""
                fk_cell = cells[COL_FK_NAME]
                loc_cell = cells[COL_ASSET_LOCATION]
                asset_id = fk_cell.get("value") or ""
                # value is the Tech_Asset__c id; label is the human name like
                # "215894 / 952209001498 / netapp2-pod257-ncg10-fra3".
                if not _SF_ID_RE.match(asset_id):
                    asset_id = ""
                parsed.append({
                    "id": cells[COL_CASE_NUMBER]["value"],
                    "name": cells[COL_CASE_NUMBER]["label"],
                    "location": location,
                    "rack": rack,
                    # Default to Sev5 (lowest) when the cell is missing or
                    # contains an unexpected value.
                    "priority": sev if sev in ALL_SEVERITIES else "Sev5",
                    "status": status,
                    "componentType": cells[COL_SUBJECT].get("label") or "",
                    "createdDate": created,
                    "assignee": cells[COL_OWNER].get("label") or "",
                    "assetId": asset_id,
                    "assetName": fk_cell.get("label") or "",
                    "assetLocationPath": loc_cell.get("label") or "",
                })
        self._cached_rows = parsed
        return parsed

    def get_active_rmas(self, locations: Optional[set[str]] = None) -> RmaActiveResponse:
        # Three independent SF round-trips: the report rows, the RTS-today
        # counter (CaseHistory query), and my-RTS summary (another
        # CaseHistory query). Run them concurrently — saves ~4s on a
        # cold load.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_rows = ex.submit(self._fetch_rows)
            f_rts_today = ex.submit(self._count_return_to_service_today, locations)
            f_my_rts = ex.submit(self.get_my_rts_summary, locations)
            all_rows = f_rows.result()
            rts_today = f_rts_today.result()
            my_open, my_closed = f_my_rts.result()

        rows = (
            [r for r in all_rows if r["location"] in locations]
            if locations is not None
            else all_rows
        )
        buckets_data: dict[str, dict] = {}
        for r in rows:
            status = r["status"]
            entry = buckets_data.setdefault(status, {
                "count": 0,
                "prio": {s: 0 for s in ALL_SEVERITIES},
                "runtime": 0.0,
            })
            entry["count"] += 1
            entry["prio"][r["priority"]] += 1
            entry["runtime"] += (self._now() - r["createdDate"]).total_seconds()

        buckets = [
            StatusBucket(
                status=status,
                count=data["count"],
                color=STATUS_COLORS.get(status, "#9CA3AF"),
                prioBreakdown=PrioBreakdown(**data["prio"]),
                totalRuntimeSeconds=int(data["runtime"]),
            )
            for status, data in buckets_data.items()
        ]
        # Total per-location counts always reflect the unfiltered universe so
        # the header pills can show e.g. "FRA3 · 46" even when FRA3 is the
        # only location currently selected.
        location_counts: dict[str, int] = {}
        for r in all_rows:
            loc = r["location"] or ""
            if loc:
                location_counts[loc] = location_counts.get(loc, 0) + 1
        return RmaActiveResponse(
            total=len(rows),
            buckets=buckets,
            returnToServiceToday=rts_today,
            myRtsOpen=my_open,
            myRtsClosedTotal=my_closed,
            locationCounts=location_counts,
            sites=self._report_site_codes(),
            fetchedAt=self._now(),
        )

    def _current_user_id(self) -> Optional[str]:
        """Resolve the active Salesforce user's Id, cached for the client lifetime."""
        info = self.get_current_user_info()
        return info.get("id") if info else None

    def get_current_user_info(self) -> Optional[dict]:
        """Return ``{id, username, name}`` for the active SF session, or
        None if it can't be resolved. Cached for the client lifetime so
        the /api/me handler doesn't pay a chatter round-trip per call."""
        if self._user_info_cache is not None:
            return self._user_info_cache
        if self._sf is None:
            return None
        try:
            info = self._sf.restful("chatter/users/me")
        except SalesforceExpiredSession:
            raise
        except Exception:
            return None
        out = {
            "id": info.get("id") or "",
            "username": info.get("username") or "",
            "name": info.get("displayName")
                    or info.get("firstName", "") + " " + info.get("lastName", ""),
        }
        # Strip the leading space if firstName was empty.
        out["name"] = (out["name"] or "").strip() or out["username"]
        self._user_info_cache = out
        # Keep the legacy id-only cache field in sync for hot paths.
        self._user_id_cache = out["id"]
        return out

    def get_my_rts_summary(
        self, locations: Optional[set[str]] = None,
    ) -> tuple[list[MyRtsTicket], int]:
        """Return (currently_open_rts_set_by_me, closed_total_set_by_me).

        Uses a single CaseHistory pull over the last 180 days, filtered to
        Field='Status' and CreatedById=<me>. NewValue can't be filtered in
        SOQL so the 'Return to Service' transitions are picked client-side.
        For each transition we keep the most recent timestamp per case so
        re-openings don't double-count.
        """
        if self._sf is None:
            return [], 0
        user_id = self._current_user_id()
        if not user_id or not _SF_ID_RE.match(user_id):
            return [], 0
        sites = self._report_site_codes()
        if not sites:
            # No site scope yet — the report hasn't loaded. Return empty
            # rather than firing an INCLUDES() clause with no values
            # (which is invalid SOQL anyway).
            return [], 0
        sites_clause = ",".join(f"'{s}'" for s in sites)
        soql = (
            "SELECT CaseId, NewValue, CreatedDate, "
            "Case.CaseNumber, Case.Subject, Case.Status, "
            "Case.SM_Data_Center_Facility__c "
            "FROM CaseHistory "
            "WHERE Field = 'Status' "
            f"AND CreatedById = '{user_id}' "
            "AND CreatedDate = LAST_N_DAYS:180 "
            "AND Case.SM_Data_Center_Facility__c "
            f"INCLUDES ({sites_clause}) "
            "ORDER BY CreatedDate DESC LIMIT 2000"
        )
        try:
            result = self._sf.query_all(soql)
        except SalesforceExpiredSession:
            raise
        except Exception:
            return [], 0

        # Keep only the most recent transition-to-RTS per case.
        seen_cases: dict[str, dict] = {}
        for rec in result.get("records", []):
            if rec.get("NewValue") != "Return to Service":
                continue
            cid = rec.get("CaseId")
            if not cid or cid in seen_cases:
                continue
            seen_cases[cid] = rec

        open_tickets: list[MyRtsTicket] = []
        closed_total = 0
        for cid, rec in seen_cases.items():
            case = rec.get("Case") or {}
            facility = case.get("SM_Data_Center_Facility__c") or ""
            if locations is not None and not any(
                loc in facility.split(";") for loc in locations
            ):
                continue
            status = case.get("Status")
            if status == "Return to Service":
                open_tickets.append(MyRtsTicket(
                    id=cid,
                    name=case.get("CaseNumber") or cid,
                    location=facility,
                    subject=case.get("Subject") or "",
                    setAt=_parse_iso(rec["CreatedDate"]),
                ))
            elif status == "Closed":
                closed_total += 1

        open_tickets.sort(key=lambda t: t.setAt, reverse=True)
        return open_tickets, closed_total

    def _mention_needles(self) -> tuple[str, ...]:
        """Compile the case-insensitive mention tokens for "addressed to me".

        Built dynamically from:
        - the active SF user's username (e.g. ``@nelamin``)
        - the bare username before ``@`` (covers ``@nelamin@gus.com`` shapes)
        - the user's display name (``@najih el amin``)
        - one ``@dceng-{site}`` / ``@dceng {site}`` pair per site code
          covered by the active report — Frankfurt contributes
          ``dceng-fra1/2/3``, Paris would contribute ``dceng-cdg1/2/3``,
          and so on without any code change.

        Returns an empty tuple if no SF user can be resolved and the
        report hasn't loaded yet (offline test, broken session) — the
        caller treats that as "no mentions match", which is correct:
        we'd rather miss a highlight than highlight everything.
        """
        needles: list[str] = []
        info = self.get_current_user_info() or {}
        username = (info.get("username") or "").lower()
        name = (info.get("name") or "").lower()
        if username:
            needles.append(f"@{username}")
            local = username.split("@", 1)[0]
            if local and local != username:
                needles.append(f"@{local}")
        if name:
            needles.append(f"@{name}")
        for site in self._report_site_codes():
            slug = site.lower()
            needles.append(f"@dceng-{slug}")
            needles.append(f"@dceng {slug}")
        # Dedupe while preserving order so the cheapest matches go first.
        seen: set[str] = set()
        out: list[str] = []
        for n in needles:
            if n not in seen:
                seen.add(n)
                out.append(n)
        return tuple(out)

    def _report_site_codes(self) -> list[str]:
        """Return the distinct site codes seen in the active report,
        plus the obvious 1/2/3 siblings of each prefix.

        The active report only carries cases that currently exist for
        each site — if FRA1 happens to have zero open RMAs right now we
        still want it visible as a filter pill. So we extract the
        unique prefixes (FRA / CDG / …) and emit prefix1/prefix2/prefix3
        for each. Returns an empty list if the report hasn't loaded yet
        — callers treat that as "no scope known", which is correct: a
        FRA-shaped fallback would silently filter every other region
        out of every cross-region SOQL we run.
        """
        if not self._cached_rows:
            try:
                self._fetch_rows()
            except Exception:
                logger.exception("report rows fetch failed")
        prefixes: set[str] = set()
        seen: set[str] = set()
        for r in self._cached_rows:
            for tok in (r.get("location") or "").split(";"):
                tok = tok.strip().upper()
                if not tok:
                    continue
                seen.add(tok)
                # Strip trailing digits/letter to get the bare prefix.
                m = re.match(r"^([A-Z]{2,4})", tok)
                if m:
                    prefixes.add(m.group(1))
        if not prefixes:
            return []
        out: set[str] = set(seen)
        for p in prefixes:
            for i in (1, 2, 3):
                out.add(f"{p}{i}")
        return sorted(out)

    def get_work_items(self, limit: int = 200) -> list[WorkItem]:
        """Return open GUS work items (ADM_Work__c) for the active
        report's region(s), newest-modified first.

        Region scoping mirrors the rest of the client: it derives the
        site codes from the active report (FRA1/2/3 → prefix FRA, CDG
        → CDG, …) with NO hardcoded site. A work item counts as "this
        region" when either

          - its scrum team is ``DCENG-<prefix>…`` (the site's own team), OR
          - its subject begins with a full site code (``FRA3 …``)

        The second arm matters because cross-team work for a site —
        e.g. the *Data Center Compliance* team's media-destruction
        stories — lives under a different scrum team but always names
        the site in the subject. Filtering on team alone would hide it.

        The site tokens are allow-listed against ``_SITE_TOKEN_RE`` /
        ``_SITE_PREFIX_RE`` before they touch the SOQL string, so even
        though they originate from authenticated report data they can
        never widen the query. Returns an empty list when the report
        hasn't loaded yet — same defensive contract as the CaseHistory
        scoping paths.
        """
        if self._sf is None:
            return []
        sites = self._report_site_codes()
        if not sites:
            return []
        site_tokens = [s for s in sites if _SITE_TOKEN_RE.match(s)]
        prefixes = sorted({
            m.group(1) for s in site_tokens
            if (m := re.match(r"^([A-Z]{2,4})", s))
        })
        prefixes = [p for p in prefixes if _SITE_PREFIX_RE.match(p)]
        if not prefixes:
            return []
        clauses = [f"Scrum_Team_Name__c LIKE 'DCENG-{p}%'" for p in prefixes]
        clauses += [f"Subject__c LIKE '{tok}%'" for tok in site_tokens]
        scope = " OR ".join(clauses)
        soql = (
            "SELECT Name, Subject__c, Status__c, Type__c, "
            "Scrum_Team_Name__c, Priority__c, LastModifiedDate, "
            "Assignee__r.Name, Case__c, Case__r.CaseNumber, Id "
            "FROM ADM_Work__c "
            f"WHERE Closed__c = 0 AND ({scope}) "
            f"ORDER BY LastModifiedDate DESC LIMIT {int(limit)}"
        )
        try:
            records = self._sf.query_all(soql).get("records", [])
        except SalesforceExpiredSession:
            raise
        except Exception:
            logger.exception("work-items query failed")
            return []
        out: list[WorkItem] = []
        for r in records:
            assignee = (r.get("Assignee__r") or {}).get("Name") or ""
            case_lookup = r.get("Case__r") or {}
            raw_modified = r.get("LastModifiedDate") or ""
            out.append(WorkItem(
                id=r["Id"],
                name=r.get("Name") or r["Id"],
                subject=r.get("Subject__c") or "",
                status=r.get("Status__c") or "",
                type=r.get("Type__c") or "",
                team=r.get("Scrum_Team_Name__c") or "",
                assignee=assignee,
                priority=r.get("Priority__c") or "",
                lastModified=_parse_iso(raw_modified) if raw_modified else None,
                caseNumber=case_lookup.get("CaseNumber") or "",
                caseId=r.get("Case__c") or "",
            ))
        return out

    def get_work_item_detail(self, identifier: str) -> Optional[WorkItemDetail]:
        """Return the full detail for one work item, looked up by its
        human work id ("W-23124643") or its Salesforce 18-char id.

        The identifier is allow-listed against ``_WORK_ID_RE`` /
        ``_SF_ID_RE`` before it touches SOQL — the regex is the only
        injection defence (SOQL has no parameter binding). Returns None
        when nothing matches. Not region-scoped: a work item the user
        clicked in the (already region-scoped) list is, by definition,
        theirs to open; re-scoping here would only add a failure mode.
        """
        if self._sf is None:
            return None
        ident = (identifier or "").strip()
        if _WORK_ID_RE.match(ident):
            field, safe = "Name", ident
        elif _SF_ID_RE.match(ident):
            field, safe = "Id", ident
        else:
            return None
        soql = (
            "SELECT Id, Name, Subject__c, Status__c, Story_Status__c, "
            "Type__c, Priority__c, Scrum_Team_Name__c, Assignee__r.Name, "
            "Product_Owner__r.Name, QA_Engineer__r.Name, Story_Points__c, "
            "Age__c, Days_In_Progress__c, Sprint_Name__c, Epic_Name__c, "
            "Product_Tag_Name__c, Due_Date__c, CreatedDate, "
            "LastModifiedDate, Case__c, Case__r.CaseNumber, Details__c "
            f"FROM ADM_Work__c WHERE {field} = '{safe}' LIMIT 1"
        )
        try:
            records = self._sf.query(soql).get("records", [])
        except SalesforceExpiredSession:
            raise
        except Exception:
            logger.exception("work-item detail query failed")
            return None
        if not records:
            return None
        r = records[0]

        def _dt(raw: Optional[str]) -> Optional[datetime]:
            return _parse_iso(raw) if raw else None

        case_lookup = r.get("Case__r") or {}
        details_plain, details_blocks = _parse_details(r.get("Details__c") or "")
        return WorkItemDetail(
            id=r["Id"],
            name=r.get("Name") or r["Id"],
            subject=r.get("Subject__c") or "",
            status=r.get("Status__c") or "",
            storyStatus=r.get("Story_Status__c") or "",
            type=r.get("Type__c") or "",
            priority=r.get("Priority__c") or "",
            team=r.get("Scrum_Team_Name__c") or "",
            assignee=(r.get("Assignee__r") or {}).get("Name") or "",
            productOwner=(r.get("Product_Owner__r") or {}).get("Name") or "",
            qaEngineer=(r.get("QA_Engineer__r") or {}).get("Name") or "",
            storyPoints=r.get("Story_Points__c"),
            ageDays=r.get("Age__c"),
            daysInProgress=r.get("Days_In_Progress__c"),
            sprint=r.get("Sprint_Name__c") or "",
            epic=r.get("Epic_Name__c") or "",
            productTag=r.get("Product_Tag_Name__c") or "",
            theme=self._get_work_item_theme(r["Id"]),
            dueDate=_dt(r.get("Due_Date__c")),
            createdDate=_dt(r.get("CreatedDate")),
            lastModified=_dt(r.get("LastModifiedDate")),
            details=details_plain,
            detailsBlocks=[_details_block(b) for b in details_blocks],
            caseNumber=case_lookup.get("CaseNumber") or "",
            caseId=r.get("Case__c") or "",
            history=self._get_work_item_history(r["Id"]),
        )

    # Tracked fields we surface in the status-verlauf timeline, mapped to
    # human labels. ADM_Work__History stores the API name in ``Field``.
    # We deliberately ignore the dozens of internal/rollup fields that also
    # get tracked (Column__c, ranks, sprint-ids, …) — only the ones a human
    # cares about for "how did this story move".
    _HISTORY_FIELDS = {
        "Status__c": "Status",
        "Assignee__c": "Assignee",
        "QA_Engineer__c": "QA Engineer",
        "Product_Owner__c": "Product Owner",
        "Story_Points__c": "Story Points",
        "Priority__c": "Priority",
        "Type__c": "Type",
    }

    def _get_work_item_history(self, work_id: str) -> list[WorkItemHistoryEvent]:
        """Newest-first tracked-field changes for one work item.

        ``work_id`` is the SF 18-char id of an ADM_Work__c we just
        resolved from the (already region-scoped) detail query, so it's
        re-validated against ``_SF_ID_RE`` purely as injection defence
        before it touches the SOQL f-string.

        Salesforce records reference-field changes twice — one row with
        the raw 15/18-char ids, one with the resolved display names. We
        keep the human-readable row and drop the id-only one so the
        timeline shows "Bhavesh Mistry → Najih El Amin", not the ids.
        """
        if self._sf is None or not _SF_ID_RE.match(work_id):
            return []
        fields_in = ", ".join(f"'{f}'" for f in self._HISTORY_FIELDS)
        soql = (
            "SELECT Field, OldValue, NewValue, CreatedBy.Name, CreatedDate "
            f"FROM ADM_Work__History WHERE ParentId = '{work_id}' "
            f"AND Field IN ({fields_in}) "
            "ORDER BY CreatedDate DESC LIMIT 60"
        )
        try:
            records = self._sf.query_all(soql).get("records", [])
        except SalesforceExpiredSession:
            raise
        except Exception:
            logger.exception("work-item history query failed")
            return []
        out: list[WorkItemHistoryEvent] = []
        for r in records:
            old = "" if r.get("OldValue") is None else str(r["OldValue"])
            new = "" if r.get("NewValue") is None else str(r["NewValue"])
            # Drop the id-only twin of a reference-field change.
            if _SF_ID_RE.match(old) or _SF_ID_RE.match(new):
                continue
            raw_at = r.get("CreatedDate") or ""
            out.append(WorkItemHistoryEvent(
                field=self._HISTORY_FIELDS.get(r.get("Field"), r.get("Field") or ""),
                oldValue=old,
                newValue=new,
                by=(r.get("CreatedBy") or {}).get("Name") or "",
                at=_parse_iso(raw_at) if raw_at else None,
            ))
        return out

    def _get_work_item_theme(self, work_id: str) -> str:
        """Comma-joined theme name(s) for one work item.

        Themes live on the junction object ``ADM_Theme_Assignment__c``,
        not the deprecated ``Theme__c`` field. ``work_id`` is re-validated
        against ``_SF_ID_RE`` before it touches SOQL. Rare for FRA items
        (most carry none) so an empty string is the common, expected
        result; the UI hides the field when it's blank.
        """
        if self._sf is None or not _SF_ID_RE.match(work_id):
            return ""
        soql = (
            "SELECT Theme__r.Name FROM ADM_Theme_Assignment__c "
            f"WHERE Work__c = '{work_id}' LIMIT 10"
        )
        try:
            records = self._sf.query_all(soql).get("records", [])
        except SalesforceExpiredSession:
            raise
        except Exception:
            logger.exception("work-item theme query failed")
            return ""
        names = [
            (rec.get("Theme__r") or {}).get("Name") or "" for rec in records
        ]
        return ", ".join(n for n in names if n)

    def get_work_item_feed(self, work_id: str, limit: int = 50) -> list[dict]:
        """Chatter feed (posts + threaded comments + tracked changes) for
        one work item, newest-first.

        ``ADM_Work__Feed`` — unlike ``FeedItem`` — accepts a direct
        ``ParentId`` filter, so the whole feed comes back in one query.
        ``work_id`` is re-validated against ``_SF_ID_RE`` before it touches
        SOQL. Post / comment bodies are parsed into the same structured
        rich-text blocks as the Details field (paragraphs, links, bold,
        and whitelisted ``sfdc://069…`` images) rather than passing HTML
        to the browser. ``CreatedBy`` on the feed + comments is polymorphic
        (User|Group|…), so author photos are resolved in a follow-up User
        query and served through the avatar proxy — putting SmallPhotoUrl
        in the subselect would make SF reject the whole query.
        """
        if self._sf is None or not _SF_ID_RE.match(work_id):
            return []
        out: list[dict] = []
        me_id = self._current_user_id()
        creator_user_ids: set[str] = set()

        def _blocks(raw: str) -> list[dict]:
            _, blocks = _parse_details(raw or "")
            return [_details_block(b).model_dump() for b in blocks]

        try:
            soql = (
                "SELECT Id, Type, Body, CreatedDate, "
                "CreatedById, CreatedBy.Name, CreatedBy.Type, "
                "(SELECT Id, OldValue, NewValue, FieldName "
                " FROM FeedTrackedChanges), "
                "(SELECT Id, CommentBody, CreatedDate, "
                " CreatedById, CreatedBy.Name, CreatedBy.Type "
                " FROM FeedComments ORDER BY CreatedDate ASC LIMIT 50) "
                f"FROM ADM_Work__Feed WHERE ParentId = '{work_id}' "
                "ORDER BY CreatedDate DESC LIMIT 50"
            )
            feeds = self._sf.query(soql).get("records", [])
        except SalesforceExpiredSession:
            raise
        except SalesforceError:
            logger.exception("get_work_item_feed: feed query failed")
            return []

        for f in feeds:
            feed_type = f.get("Type")
            creator = f.get("CreatedBy") or {}
            creator_id = f.get("CreatedById") or ""
            if creator.get("Type") == "User" and creator_id:
                creator_user_ids.add(creator_id)
            if feed_type in ("TextPost", "ContentPost"):
                out.append({
                    "id": f["Id"],
                    "kind": "post",
                    "author": creator.get("Name") or "",
                    "authorPhotoUrl": "",
                    "_creatorId": creator_id,
                    "isMine": bool(me_id and creator_id == me_id),
                    "at": f["CreatedDate"],
                    "blocks": _blocks(f.get("Body")),
                })
            elif feed_type == "TrackedChange":
                changes = (
                    (f.get("FeedTrackedChanges") or {}).get("records") or []
                )
                for ch in changes:
                    field_api = (ch.get("FieldName") or "").split(".", 1)[-1]
                    old = "" if ch.get("OldValue") is None else str(ch["OldValue"])
                    new = "" if ch.get("NewValue") is None else str(ch["NewValue"])
                    # Drop the id-only twin SF emits for reference-field
                    # changes (keep the human-readable row), same as history.
                    if _SF_ID_RE.match(old) or _SF_ID_RE.match(new):
                        continue
                    out.append({
                        "id": f"{f['Id']}:{ch['Id']}",
                        "kind": "trackedChange",
                        "author": creator.get("Name") or "",
                        "authorPhotoUrl": "",
                        "_creatorId": creator_id,
                        "isMine": bool(me_id and creator_id == me_id),
                        "at": f["CreatedDate"],
                        "blocks": [],
                        "fieldLabel": self._HISTORY_FIELDS.get(field_api, field_api),
                        "fromValue": old,
                        "toValue": new,
                    })
            for cm in (f.get("FeedComments") or {}).get("records") or []:
                cb = cm.get("CreatedBy") or {}
                cm_creator = cm.get("CreatedById") or ""
                if cb.get("Type") == "User" and cm_creator:
                    creator_user_ids.add(cm_creator)
                out.append({
                    "id": cm["Id"],
                    "kind": "comment",
                    "parentId": f["Id"],
                    "author": cb.get("Name") or "",
                    "authorPhotoUrl": "",
                    "_creatorId": cm_creator,
                    "isMine": bool(me_id and cm_creator == me_id),
                    "at": cm["CreatedDate"],
                    "blocks": _blocks(cm.get("CommentBody")),
                })

        # Resolve author photos in one follow-up query (polymorphic
        # CreatedBy ⇒ SmallPhotoUrl can't live in the subselect) and route
        # them through the avatar proxy.
        if creator_user_ids:
            try:
                ids_clause = _safe_ids_clause(list(creator_user_ids))
                if ids_clause:
                    user_rows = self._sf.query(
                        f"SELECT Id, SmallPhotoUrl FROM User "
                        f"WHERE Id IN ({ids_clause})"
                    )["records"]
                    by_id = {u["Id"]: u for u in user_rows}
                    for e in out:
                        uid = e.pop("_creatorId", None)
                        if uid and by_id.get(uid, {}).get("SmallPhotoUrl"):
                            e["authorPhotoUrl"] = f"/api/avatar/{uid}"
            except SalesforceError:
                logger.exception("get_work_item_feed: user-photo query failed")
        for e in out:
            e.pop("_creatorId", None)

        out.sort(key=lambda e: e.get("at") or "", reverse=True)
        return out[:limit]

    # Short TTL for the case-id list backing CaseHistory queries (RTS
    # today, activity log). Long enough to absorb the polling cadence
    # without re-issuing the SOQL every request, short enough that a
    # case which just moved into LAST_N_DAYS:14 (e.g. freshly opened or
    # freshly transitioned to Return to Service) appears within a poll
    # cycle without forcing the user to hit /api/refresh.
    _CASE_IDS_TTL_S = 60.0

    def _query_active_case_ids(self) -> list[str]:
        """Return all in-scope case Ids modified in the last 14 days.

        Cached with a 60-second TTL. Used to scope CaseHistory queries —
        including cases that have already moved to 'Return to Service'
        and dropped out of the active report. Site scope is derived
        from the active report so the same query works for FRA / CDG /
        any future region.
        """
        if self._sf is None:
            return []
        import time as _time
        now = _time.time()
        if (
            self._active_case_ids_cache
            and (now - self._active_case_ids_cached_at) < self._CASE_IDS_TTL_S
        ):
            return self._active_case_ids_cache
        sites = self._report_site_codes()
        if not sites:
            # Same defensive guard as _query_my_status_changes — empty
            # scope means the report hasn't loaded; better to return
            # nothing than to issue an invalid SOQL clause.
            return []
        sites_clause = ",".join(f"'{s}'" for s in sites)
        soql = (
            "SELECT Id, SM_Data_Center_Facility__c FROM Case "
            f"WHERE SM_Data_Center_Facility__c INCLUDES ({sites_clause}) "
            "AND LastModifiedDate = LAST_N_DAYS:14 LIMIT 1000"
        )
        try:
            result = self._sf.query_all(soql)
            ids: list[str] = []
            facility_by_id: dict[str, str] = {}
            for rec in result.get("records", []):
                rec_id = rec["Id"]
                ids.append(rec_id)
                facility_by_id[rec_id] = rec.get("SM_Data_Center_Facility__c") or ""
            self._active_case_ids_cache = ids
            self._facility_by_case_id = facility_by_id
            self._active_case_ids_cached_at = now
            return ids
        except SalesforceExpiredSession:
            raise
        except Exception:
            return []

    def _count_return_to_service_today(
        self, locations: Optional[set[str]] = None,
    ) -> int:
        """Count cases for the active report whose Status changed to
        'Return to Service' since midnight in the SF user's timezone.

        SOQL doesn't allow filtering CaseHistory.NewValue, so we fetch
        today's status changes for the active report's site scope and
        filter client-side. Resets automatically at midnight because
        ``CreatedDate = TODAY`` re-evaluates per call.
        """
        if self._sf is None:
            return 0
        ids = self._query_active_case_ids()
        if locations is not None:
            ids = [
                i for i in ids
                if any(
                    loc in (self._facility_by_case_id.get(i) or "").split(";")
                    for loc in locations
                )
            ]
        ids_clause = _safe_ids_clause(ids)
        if not ids_clause:
            return 0
        soql = (
            "SELECT CaseId, NewValue FROM CaseHistory "
            "WHERE Field = 'Status' "
            f"AND CaseId IN ({ids_clause}) "
            "AND CreatedDate = TODAY"
        )
        try:
            result = self._sf.query_all(soql)
            return sum(
                1 for r in result.get("records", [])
                if r.get("NewValue") == "Return to Service"
            )
        except SalesforceExpiredSession:
            raise
        except Exception:
            return 0

    def _query_asset_types(self, asset_ids: list[str]) -> dict[str, str]:
        """Map Tech_Asset__c id -> human-readable asset type string.

        Prefers the related Asset_Type__r.Name (e.g. "DELL - POWEREDGE -
        R650xs - SSKUF-CC-25G"); falls back to a hyphenated combination of
        Asset_Type_Manufacturer__c / Asset_Type_Make__c / Asset_Type_Model__c
        so we still show something even when the lookup is missing.
        """
        ids_clause = _safe_ids_clause(asset_ids)
        if not ids_clause:
            return {}
        soql = (
            "SELECT Id, Asset_Type__r.Name, "
            "Asset_Type_Manufacturer__c, Asset_Type_Make__c, "
            "Asset_Type_Model__c, Asset_Type_Asset_Type__c "
            f"FROM Tech_Asset__c WHERE Id IN ({ids_clause})"
        )
        try:
            result = self._sf.query_all(soql)
        except SalesforceExpiredSession:
            raise
        except Exception:
            return {}
        out: dict[str, str] = {}
        for r in result.get("records", []):
            asset_type_lookup = (r.get("Asset_Type__r") or {}).get("Name") or ""
            if asset_type_lookup:
                out[r["Id"]] = asset_type_lookup
                continue
            parts = [
                r.get("Asset_Type_Manufacturer__c"),
                r.get("Asset_Type_Make__c"),
                r.get("Asset_Type_Model__c"),
                r.get("Asset_Type_Asset_Type__c"),
            ]
            joined = " - ".join(p for p in parts if p)
            if joined:
                out[r["Id"]] = joined
        return out

    def _query_descriptions(
        self, case_ids: list[str],
    ) -> tuple[dict[str, list[CoolanLink]], dict[str, str]]:
        """One-shot pull of Case.Description for the given ids.

        Returns ``(coolan_links_by_id, description_by_id)``. Coolan links
        are parsed out of the description text — anchor labels match
        Components / Machine / Logs in that order so the UI can keep them
        consistent. The raw description is kept verbatim for the Description
        column tooltip.
        """
        ids_clause = _safe_ids_clause(case_ids)
        if not ids_clause:
            return {}, {}
        soql = (
            f"SELECT Id, Description FROM Case WHERE Id IN ({ids_clause})"
        )
        try:
            result = self._sf.query_all(soql)
        except SalesforceExpiredSession:
            raise
        except Exception:
            return {}, {}

        # Map raw labels to short tooltip titles, and order them.
        label_map = [
            ("Components Link", "Components"),
            ("Machine Link", "Machine"),
            ("Relevant Log File Link", "Logs"),
        ]
        pattern = re.compile(
            r"Coolan\s+(Components Link|Machine Link|Relevant Log File Link)\s*:\s*(\S+)",
            re.IGNORECASE,
        )

        coolan_out: dict[str, list[CoolanLink]] = {}
        desc_out: dict[str, str] = {}
        for r in result.get("records", []):
            desc = r.get("Description") or ""
            desc_out[r["Id"]] = desc
            found: dict[str, str] = {}
            for raw_label, url in pattern.findall(desc):
                key = raw_label.strip().title()
                if key not in found:
                    found[key] = url
            ordered: list[CoolanLink] = []
            for raw_label, short_title in label_map:
                url = found.get(raw_label.title())
                if url:
                    ordered.append(CoolanLink(title=short_title, url=url))
            if ordered:
                coolan_out[r["Id"]] = ordered
        return coolan_out, desc_out

    def get_tickets_for_status(
        self, status: str, locations: Optional[set[str]] = None,
    ) -> list[RmaTicket]:
        if not self._cached_rows:
            self._fetch_rows()
        rows = [
            r for r in self._cached_rows
            if r["status"] == status
            and (locations is None or r["location"] in locations)
        ]
        if not rows:
            return []

        asset_ids = list({r["assetId"] for r in rows if r.get("assetId")})
        case_ids = [r["id"] for r in rows]
        # Run asset types, descriptions and status-change timestamps in parallel.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_assets = ex.submit(self._query_asset_types, asset_ids)
            f_desc = ex.submit(self._query_descriptions, case_ids)
            f_status_ts = ex.submit(self._query_last_status_change, case_ids)
            asset_type_by_id = f_assets.result()
            coolan_by_case, description_by_case = f_desc.result()
            status_changed_by_case = f_status_ts.result()

        # Resolve Coolan machines in **two** batched calls instead of N.
        # First pass: every ticket whose description carries a parseable
        # machine UUID is covered by one ``machines(where: id IN […])``
        # query. Second pass: remaining tickets fall back to the
        # serial/hostname _ilike search via a single ``_or`` query.
        # That cuts the wait from ~28s for 35 tickets to ~1.5s.
        uuid_per_case: dict[str, str] = {}
        for r in rows:
            for link in coolan_by_case.get(r["id"], []):
                u = coolan_client.extract_machine_uuid(link.url)
                if u:
                    uuid_per_case[r["id"]] = u
                    break

        machine_by_case: dict[str, dict] = {}
        all_uuids = list({u for u in uuid_per_case.values() if u})
        if all_uuids:
            uuid_results = coolan_client.get_machines_by_uuids(all_uuids)
            for cid, u in uuid_per_case.items():
                m = uuid_results.get(u)
                if m:
                    machine_by_case[cid] = m

        # Pass 2: tickets that didn't get a hit by UUID (no link, or
        # link's UUID isn't in Coolan) try a name-based lookup.
        unresolved = [
            r for r in rows
            if r["id"] not in machine_by_case and r.get("assetName")
        ]
        if unresolved:
            name_results = coolan_client.get_machines_by_search_batch(
                [r["assetName"] for r in unresolved],
            )
            for r in unresolved:
                m = name_results.get(r["assetName"])
                if m:
                    machine_by_case[r["id"]] = m

        coolan_state_by_case: dict[str, str] = {}
        for r in rows:
            machine = machine_by_case.get(r["id"])
            if machine and machine.get("uuid"):
                # If we got a UUID but the case had no parseable links yet,
                # synthesize the three standard tabs so the snowflake button
                # is useful.
                if not coolan_by_case.get(r["id"]):
                    coolan_by_case[r["id"]] = [
                        CoolanLink(**lnk)
                        for lnk in coolan_client.synthesize_links(machine["uuid"])
                    ]
            state = (machine or {}).get("state")
            coolan_state_by_case[r["id"]] = state or "unknown"

        return [
            RmaTicket(
                id=r["id"],
                name=r["name"],
                location=r["location"],
                priority=r["priority"],
                status=r["status"],
                componentType=r["componentType"],
                createdDate=r["createdDate"],
                assignee=r["assignee"],
                assetName=r.get("assetName") or "",
                assetLocationPath=r.get("assetLocationPath") or "",
                assetType=asset_type_by_id.get(r.get("assetId") or "", ""),
                description=description_by_case.get(r["id"], "") or "",
                coolanLinks=coolan_by_case.get(r["id"], []),
                coolanReportingState=coolan_state_by_case.get(r["id"]),
                statusChangedAt=status_changed_by_case.get(r["id"]),
            )
            for r in rows
        ]

    def _query_last_status_change(
        self, case_ids: list[str],
    ) -> dict[str, datetime]:
        """Return {case_id: last_status_change_datetime} for each case.

        Fetches only the most recent Status-field entry per case so the
        result set stays small even for large buckets.
        """
        ids_clause = _safe_ids_clause(case_ids)
        if not ids_clause:
            return {}
        soql = (
            "SELECT CaseId, CreatedDate "
            "FROM CaseHistory "
            f"WHERE CaseId IN ({ids_clause}) "
            "AND Field = 'Status' "
            "ORDER BY CreatedDate DESC LIMIT 2000"
        )
        records = self._sf.query_all(soql)["records"]
        result: dict[str, datetime] = {}
        for rec in records:
            cid = rec.get("CaseId") or ""
            if cid in result:
                continue  # already got the most recent one (ordered DESC)
            raw = rec.get("CreatedDate") or ""
            if raw:
                try:
                    result[cid] = datetime.fromisoformat(
                        raw.replace("Z", "+00:00")
                    )
                except ValueError:
                    pass
        return result

    def _query_history(self, ticket_sf_ids: list[str]) -> list[dict]:
        ids_clause = _safe_ids_clause(ticket_sf_ids)
        if not ids_clause:
            return []
        soql = (
            "SELECT Id, CaseId, Field, OldValue, NewValue, "
            "CreatedDate, CreatedBy.Username, "
            "Case.CaseNumber, Case.Status, Case.SM_Data_Center_Facility__c "
            "FROM CaseHistory "
            f"WHERE CaseId IN ({ids_clause}) "
            "AND Field = 'Status' "
            "ORDER BY CreatedDate DESC LIMIT 200"
        )
        return self._sf.query_all(soql)["records"]

    def _query_feed(self, ticket_sf_ids: list[str]) -> list[dict]:
        ids_clause = _safe_ids_clause(ticket_sf_ids)
        if not ids_clause:
            return []
        # Use CaseComment (FeedItem requires a filter by Id, not ParentId).
        # Parent.Status / Parent.CaseNumber come back via the Case lookup.
        soql = (
            "SELECT Id, ParentId, CommentBody, CreatedDate, "
            "CreatedBy.Username, Parent.Status, Parent.CaseNumber "
            "FROM CaseComment "
            f"WHERE ParentId IN ({ids_clause}) "
            "ORDER BY CreatedDate DESC LIMIT 200"
        )
        return self._sf.query_all(soql)["records"]

    def _query_chatter_feed(self, ticket_sf_ids: list[str]) -> list[dict]:
        """Pull Chatter activity (top-level posts AND replies) via Case.

        FeedItem and FeedComment both refuse a top-level ParentId filter
        (Salesforce requires an Id filter). Going through Case as a
        subquery sidesteps that. We pick up:

        - TextPost / ContentPost FeedItems (top-level Chatter posts)
        - All FeedComments under any FeedItem (the threaded replies —
          this is where most engineer-to-engineer conversation actually
          happens, often hanging off TrackedChange events)

        Each returned dict is normalized to the FeedItem-shape used by
        the comment-event builder: {Id, ParentId, Body, CreatedDate,
        CreatedBy.Username, _caseStatus}.
        """
        ids_clause = _safe_ids_clause(ticket_sf_ids)
        if not ids_clause:
            return []
        # Filter Feeds.Type in SOQL so the inner LIMIT doesn't get burned
        # on TrackedChange / status-history rows (each Case.Status flip
        # generates one). Without this, a busy case quickly blows past
        # 50 feed slots on system events alone and pushes real user
        # posts out of the window — which is how AdvancedTextPosts like
        # "@DCEng-FRA3 please repair the following links" get dropped.
        soql = (
            "SELECT Id, CaseNumber, Status, "
            "(SELECT Id, ParentId, Type, Body, CreatedDate, "
            "CreatedBy.Username, "
            "(SELECT Id, CommentBody, CreatedDate, CreatedBy.Username "
            " FROM FeedComments ORDER BY CreatedDate DESC LIMIT 25) "
            "FROM Feeds "
            "WHERE Type IN "
            "('TextPost','AdvancedTextPost','ContentPost','LinkPost') "
            "ORDER BY CreatedDate DESC LIMIT 50) "
            f"FROM Case WHERE Id IN ({ids_clause})"
        )
        records = self._sf.query_all(soql)["records"]
        out: list[dict] = []
        for case in records:
            case_id = case["Id"]
            case_status = case.get("Status")
            case_number = case.get("CaseNumber") or ""
            feeds = (case.get("Feeds") or {}).get("records") or []
            for f in feeds:
                # Top-level posts — keep every shape of real user post
                # (TextPost, AdvancedTextPost — used by GUS for formatted
                # bodies with @-mentions like "to GUS Only" announcements,
                # ContentPost for posts with attachments, LinkPost for
                # link shares). Drop TrackedChange (duplicate of
                # CaseHistory) and other system-generated event types.
                if f.get("Type") in (
                    "TextPost", "AdvancedTextPost",
                    "ContentPost", "LinkPost",
                ):
                    out.append({
                        "Id": f["Id"],
                        "ParentId": case_id,
                        "Body": f.get("Body") or "",
                        "CreatedDate": f["CreatedDate"],
                        "CreatedBy": f.get("CreatedBy") or {},
                        "_caseStatus": case_status,
                        "_caseNumber": case_number,
                    })
                # Threaded replies under ANY feed item (often the
                # interesting team-to-team chatter).
                for cm in (f.get("FeedComments") or {}).get("records") or []:
                    out.append({
                        "Id": cm["Id"],
                        "ParentId": case_id,
                        "Body": cm.get("CommentBody") or "",
                        "CreatedDate": cm["CreatedDate"],
                        "CreatedBy": cm.get("CreatedBy") or {},
                        "_caseStatus": case_status,
                        "_caseNumber": case_number,
                    })
        return out

    def get_case_feed(self, case_id: str, limit: int = 50) -> list[dict]:
        """Combined Chatter + CaseComment + EmailMessage feed for one case.

        Returns a flat list ordered newest-first, normalized to the shape
        the FE expects (FeedEntry). Threading comes via parentId on the
        Chatter replies; CaseComment and EmailMessage records come back
        as top-level posts since they live in their own thread visually.
        """
        if not _SF_ID_RE.match(case_id):
            return []
        out: list[dict] = []
        me_id = self._current_user_id()
        # Track which user ids appear as authors so we can fetch their
        # photos in one shot afterwards (CreatedBy on FeedItem/Comment is
        # polymorphic User|Group, so SmallPhotoUrl can't go in the
        # subselect — see SF "Name" entity).
        creator_user_ids: set[str] = set()

        # 1. Chatter — top-level FeedItem (Text/Content posts + tracked
        # field changes) and threaded replies.
        try:
            soql = (
                "SELECT Id, "
                "(SELECT Id, Type, Body, CreatedDate, "
                "CreatedById, CreatedBy.Name, CreatedBy.Type, "
                "(SELECT Id, OldValue, NewValue, FieldName "
                " FROM FeedTrackedChanges), "
                "(SELECT Id, CommentBody, CreatedDate, "
                " CreatedById, CreatedBy.Name, CreatedBy.Type "
                " FROM FeedComments ORDER BY CreatedDate ASC LIMIT 50) "
                "FROM Feeds ORDER BY CreatedDate DESC LIMIT 50) "
                f"FROM Case WHERE Id = '{case_id}'"
            )
            records = self._sf.query(soql)["records"]
            for case in records:
                feeds = (case.get("Feeds") or {}).get("records") or []
                for f in feeds:
                    feed_type = f.get("Type")
                    creator = f.get("CreatedBy") or {}
                    creator_id = f.get("CreatedById") or ""
                    if creator.get("Type") == "User" and creator_id:
                        creator_user_ids.add(creator_id)
                    if feed_type in ("TextPost", "ContentPost"):
                        out.append({
                            "id": f["Id"],
                            "kind": "post",
                            "source": "chatter",
                            "author": creator.get("Name") or "",
                            "authorUsername": "",
                            "authorPhotoUrl": "",
                            "_creatorId": creator_id,
                            "isMine": bool(me_id and creator_id == me_id),
                            "at": f["CreatedDate"],
                            "body": _strip_html(f.get("Body") or ""),
                        })
                    elif feed_type == "TrackedChange":
                        # One FeedItem can carry multiple field changes;
                        # render each as its own row so the diff pill
                        # shows the correct field name.
                        changes = (
                            (f.get("FeedTrackedChanges") or {}).get("records")
                            or []
                        )
                        for ch in changes:
                            field_full = ch.get("FieldName") or ""
                            # Strip "Case." / "Tech_Asset__c." prefix so
                            # the UI shows "Status" instead of "Case.Status".
                            field_label = field_full.split(".", 1)[-1]
                            out.append({
                                "id": f"{f['Id']}:{ch['Id']}",
                                "kind": "trackedChange",
                                "source": "chatter",
                                "author": creator.get("Name") or "",
                                "authorUsername": "",
                                "authorPhotoUrl": "",
                                "_creatorId": creator_id,
                                "isMine": bool(me_id and creator_id == me_id),
                                "at": f["CreatedDate"],
                                "body": "",
                                "fieldLabel": field_label,
                                "fromValue": (
                                    "" if ch.get("OldValue") is None
                                    else str(ch.get("OldValue"))
                                ),
                                "toValue": (
                                    "" if ch.get("NewValue") is None
                                    else str(ch.get("NewValue"))
                                ),
                            })
                    # Skip CaseCommentPost (duplicates the CaseComment
                    # source we already render in tab 2) and other
                    # specialty types (LinkPost, CanvasPost, …) — add
                    # them here if a real case shows them in the wild.
                    for cm in (f.get("FeedComments") or {}).get("records") or []:
                        cb = cm.get("CreatedBy") or {}
                        cm_creator = cm.get("CreatedById") or ""
                        if cb.get("Type") == "User" and cm_creator:
                            creator_user_ids.add(cm_creator)
                        out.append({
                            "id": cm["Id"],
                            "kind": "comment",
                            "source": "chatter",
                            "parentId": f["Id"],
                            "author": cb.get("Name") or "",
                            "authorUsername": "",
                            "authorPhotoUrl": "",
                            "_creatorId": cm_creator,
                            "isMine": bool(me_id and cm_creator == me_id),
                            "at": cm["CreatedDate"],
                            "body": _strip_html(cm.get("CommentBody") or ""),
                        })
        except SalesforceError:
            logger.exception("get_case_feed: chatter query failed")

        # 2. Case Comments — older textbox-style thread. CreatedBy is
        # polymorphic User|SelfServiceUser, so SmallPhotoUrl can't go
        # in the subselect — we resolve photos via the User follow-up
        # query below.
        try:
            soql = (
                "SELECT Id, CommentBody, CreatedDate, "
                "CreatedById, CreatedBy.Name, CreatedBy.Type "
                "FROM CaseComment "
                f"WHERE ParentId = '{case_id}' "
                "ORDER BY CreatedDate DESC LIMIT 50"
            )
            for r in self._sf.query(soql)["records"]:
                cb = r.get("CreatedBy") or {}
                creator_id = r.get("CreatedById") or ""
                if cb.get("Type") == "User" and creator_id:
                    creator_user_ids.add(creator_id)
                out.append({
                    "id": r["Id"],
                    "kind": "post",
                    "source": "caseComments",
                    "author": cb.get("Name") or "",
                    "authorUsername": "",
                    "authorPhotoUrl": "",
                    "_creatorId": creator_id,
                    "isMine": bool(me_id and creator_id == me_id),
                    "at": r["CreatedDate"],
                    "body": r.get("CommentBody") or "",
                })
        except SalesforceError:
            logger.exception("get_case_feed: case-comment query failed")

        # 3. Email Messages — incoming + outgoing customer/vendor mail.
        try:
            soql = (
                "SELECT Id, FromName, FromAddress, ToAddress, Subject, "
                "TextBody, MessageDate, Incoming "
                "FROM EmailMessage "
                f"WHERE ParentId = '{case_id}' "
                "ORDER BY MessageDate DESC LIMIT 30"
            )
            for r in self._sf.query(soql)["records"]:
                subj = r.get("Subject") or ""
                body = r.get("TextBody") or ""
                # Compose a readable single block since the panel renders
                # plain text. Strip CRLF runs to keep it tidy.
                full = (f"Subject: {subj}\n\n" if subj else "") + body
                out.append({
                    "id": r["Id"],
                    "kind": "post",
                    "source": "email",
                    "author": r.get("FromName") or r.get("FromAddress") or "",
                    "authorUsername": r.get("FromAddress") or "",
                    "at": r.get("MessageDate") or "",
                    "body": full,
                    "incoming": bool(r.get("Incoming")),
                })
        except SalesforceError:
            logger.exception("get_case_feed: email query failed")

        # Resolve usernames in a single follow-up query, and route
        # photos through our backend avatar proxy (raw SF photo URLs
        # need a session cookie the browser doesn't have).
        if creator_user_ids:
            try:
                ids_clause = _safe_ids_clause(list(creator_user_ids))
                if ids_clause:
                    user_soql = (
                        f"SELECT Id, Username, SmallPhotoUrl "
                        f"FROM User WHERE Id IN ({ids_clause})"
                    )
                    user_rows = self._sf.query(user_soql)["records"]
                    by_id = {u["Id"]: u for u in user_rows}
                    for e in out:
                        uid = e.pop("_creatorId", None)
                        if not uid:
                            continue
                        u = by_id.get(uid)
                        if not u:
                            continue
                        if not e.get("authorUsername"):
                            e["authorUsername"] = u.get("Username") or ""
                        if not e.get("authorPhotoUrl") and u.get("SmallPhotoUrl"):
                            e["authorPhotoUrl"] = f"/api/avatar/{uid}"
            except SalesforceError:
                logger.exception("get_case_feed: user-photo query failed")
        # Drop any leftover scratch keys before returning.
        for e in out:
            e.pop("_creatorId", None)

        out.sort(key=lambda e: e.get("at") or "", reverse=True)
        return out[:limit]

    def get_activity_events(
        self, activity_type: str = "all", limit: int = 200,
        locations: Optional[set[str]] = None,
        include_bots: bool = False,
    ) -> list:
        from .models import ActivityEvent
        if not self._cached_rows:
            self._fetch_rows()
        active_ids = [r["id"] for r in self._cached_rows]
        location_by_id = {r["id"]: r["location"] for r in self._cached_rows}
        name_by_id = {r["id"]: r["name"] for r in self._cached_rows}

        # Broader id set so status changes ON cases that are now in
        # 'Return to Service' (and therefore no longer active) still
        # surface. Union with active_ids: the SOQL filter relies on
        # SM_Data_Center_Facility__c INCLUDES (sites), but some cases
        # in the report leave that field NULL — they would silently
        # drop out of the activity log otherwise. The report itself
        # already proves they're in scope, so trust it.
        soql_ids = self._query_active_case_ids()
        history_ids = list({*soql_ids, *active_ids}) if soql_ids else active_ids

        # Build the mention-token list once per request — see
        # _mention_needles() for what goes into it. Lower-cased so a
        # cheap substring check on the comment body matches every shape.
        mention_needles = self._mention_needles()

        events: list[ActivityEvent] = []

        if activity_type in ("all", "status_change"):
            for rec in self._query_history(history_ids):
                case_id = rec["CaseId"]
                ticket_name = (
                    (rec.get("Case") or {}).get("CaseNumber")
                    or name_by_id.get(case_id)
                    or case_id
                )
                case = rec.get("Case") or {}
                facility = case.get("SM_Data_Center_Facility__c") or ""
                events.append(ActivityEvent(
                    id=rec["Id"],
                    ticketSfId=case_id,
                    ticketId=ticket_name,
                    type="status_change",
                    timestamp=_parse_iso(rec["CreatedDate"]),
                    actor=(rec.get("CreatedBy") or {}).get("Username") or "",
                    fromStatus=rec.get("OldValue"),
                    toStatus=rec.get("NewValue"),
                    location=location_by_id.get(case_id) or facility,
                    caseStatus=case.get("Status"),
                ))

        if activity_type in ("all", "comment"):
            # CaseComment runs on the same broader history universe as
            # status changes and Chatter — so a comment posted shortly
            # before a case moved to RTS / Closed still surfaces in the
            # log for as long as we keep its history (LAST_N_DAYS:14).
            for rec in self._query_feed(history_ids):
                parent_id = rec["ParentId"]
                parent = rec.get("Parent") or {}
                body = rec.get("CommentBody") or ""
                lowered = body.lower()
                mentions_me = any(n in lowered for n in mention_needles)
                ticket_name = (
                    parent.get("CaseNumber")
                    or name_by_id.get(parent_id)
                    or parent_id
                )
                events.append(ActivityEvent(
                    id=rec["Id"],
                    ticketSfId=parent_id,
                    ticketId=ticket_name,
                    type="comment",
                    timestamp=_parse_iso(rec["CreatedDate"]),
                    actor=(rec.get("CreatedBy") or {}).get("Username") or "",
                    commentText=body,
                    location=location_by_id.get(parent_id, ""),
                    caseStatus=parent.get("Status"),
                    mentionsMe=mentions_me,
                ))

            # Chatter posts (FeedItem) and threaded replies (FeedComment)
            # on top of CaseComment. Use the broader history_ids universe
            # so engineer-to-engineer chatter on cases that have moved
            # to RTS/Closed but were active recently still surfaces. Bodies
            # are HTML — strip tags and decode entities so the plain text
            # ends up in the activity log and mention-detection works.
            for rec in self._query_chatter_feed(history_ids):
                parent_id = rec["ParentId"]
                raw_body = rec.get("Body") or ""
                body = _strip_html(raw_body)
                lowered = body.lower()
                mentions_me = any(n in lowered for n in mention_needles)
                ticket_name = (
                    rec.get("_caseNumber")
                    or name_by_id.get(parent_id)
                    or parent_id
                )
                events.append(ActivityEvent(
                    id=rec["Id"],
                    ticketSfId=parent_id,
                    ticketId=ticket_name,
                    type="comment",
                    timestamp=_parse_iso(rec["CreatedDate"]),
                    actor=(rec.get("CreatedBy") or {}).get("Username") or "",
                    commentText=body,
                    location=location_by_id.get(parent_id, ""),
                    caseStatus=rec.get("_caseStatus"),
                    mentionsMe=mentions_me,
                ))

        # Drop noise actors (e.g. svc_grok-fra@gus.com / svc_grok-cdg@…)
        # by default. The `include_bots` toggle lets the UI surface them
        # on demand.
        if not include_bots:
            events = [e for e in events if not _is_noise_actor(e.actor)]

        if locations is not None:
            events = [e for e in events if e.location in locations]
        events.sort(key=lambda e: e.timestamp, reverse=True)
        return events[:limit]
