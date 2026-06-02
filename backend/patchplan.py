"""Master-Patchplan integration.

Indexes a collection of cable / patch-plan rows by hostname so the
case sheet can show "what cables connect to this device" alongside
the Coolan components view.

The data source is abstracted behind ``PatchplanSource`` so we can
start with local CSV files (no auth needed) and later swap in the
Google Sheets API or a publicly-shared API-key reader without the
rest of the system noticing.

Today's source is :class:`LocalCsvSource` which scans
``~/.widash/patchplan/*.csv`` — one file per tab of the master sheet,
exported via "File → Download → CSV" in Google Sheets.
"""
from __future__ import annotations

import csv
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("widash.patchplan")


# ---------------------------------------------------------------- Data ----

@dataclass
class CableEnd:
    device: str          # hostname (e.g. "spn1-ncg0-fra3")
    port: str = ""
    make: str = ""
    room: str = ""
    rack: str = ""
    u_loc: str = ""
    tile: str = ""


@dataclass
class CableHop:
    """One patch-panel hop on the cable: PP A / PP B / PP C / PP D."""
    label: str          # "PP A", "PP B", …
    panel: str = ""
    port: str = ""


@dataclass
class Cable:
    cable_id: str        # source-of-truth: AG when present, else A
    tab: str             # tab name, used as a region/site pill
    cabled: str = ""     # x / X (active) | n (planned) | p (partial) | other
    cable_type: str = ""
    length: str = ""
    comment: str = ""
    side_a: CableEnd = field(default_factory=CableEnd)
    side_b: CableEnd = field(default_factory=CableEnd)
    hops: list[CableHop] = field(default_factory=list)


@dataclass
class PatchplanIndex:
    """Index built from a list of cables, keyed by lowercase hostname.

    A cable is indexed under both side A and side B device names so a
    lookup hits regardless of which end the engineer's RMA touches.
    Empty hostnames and obvious non-hostname strings are skipped at
    index time, not lookup time.

    Also indexed by ``(room, rack)`` so a server-hostname RMA (which
    doesn't appear in the cable rows) can still surface every cable
    going to the same physical rack — typically the ToR switch's
    uplinks plus any direct server patches.
    """
    cables: list[Cable]
    by_host: dict[str, list[Cable]]
    by_rack: dict[tuple[str, str], list[Cable]]
    revision: str
    fetched_at: float

    def cables_for(self, hostname: str) -> list[Cable]:
        if not hostname:
            return []
        key = hostname.strip().lower()
        return list(self.by_host.get(key, []))

    def cables_for_rack(self, room: str, rack: str) -> list[Cable]:
        room = _norm_rack_token(room)
        rack = _norm_rack_token(rack)
        if not room or not rack:
            return []
        return list(self.by_rack.get((room, rack), []))


# ---------------------------------------------------------------- Source ----

class PatchplanSource:
    """Returns the current set of cables.

    Implementations decide how that's loaded (local CSVs, Sheets API,
    etc.). ``revision_id`` lets the index detect changes without a
    full re-index.
    """

    def get_cables(self) -> list[Cable]:
        raise NotImplementedError

    def revision_id(self) -> str:
        """Cheap to compute fingerprint of the current source state.

        For local files: a hash of every file's mtime+size. For Sheets:
        the sheet's revision id. The index recomputes only when this
        changes between polls.
        """
        raise NotImplementedError


_RACK_TOKEN_RE = re.compile(r"^([a-z]+)0*(\d+)([a-z]?)$")


def _norm_rack_token(s: str) -> str:
    """Normalise a rack/room token for matching.

    GUS-side asset paths come 0-padded (``E04``), the patchplan stores
    them un-padded (``e4``). Strip the zero-padding once on both sides
    so the lookup is consistent. Falls back to lowercase-trim only
    when the value doesn't fit the letter+digits shape (e.g. room
    numbers like ``124``, weird outliers).
    """
    s = (s or "").strip().lower()
    if not s:
        return ""
    m = _RACK_TOKEN_RE.match(s)
    if not m:
        return s
    return f"{m.group(1)}{int(m.group(2))}{m.group(3)}"


_NON_HOSTNAME_NEEDLES = (
    "cross connect", "ACP H", "CAM H",
    "AXS-", "ODF", "PDU",
)
# Reject rack-position labels, free-text equipment notes, and
# obvious junk. Hyphens are NOT required — SAN/storage devices use
# compact names like "fra3s50esan119b" or "fra3s50fabric01" with no
# hyphen at all. The only hard rules: no spaces, at least 4 chars,
# no known noise keyword.
def _is_indexable_hostname(s: str) -> bool:
    if not s:
        return False
    s = s.strip()
    if not s or " " in s:
        return False
    if len(s) < 4:
        return False
    upper = s.upper()
    return not any(n.upper() in upper for n in _NON_HOSTNAME_NEEDLES)


# ---------------------------------------------------------------- CSV impl ----

# Header tokens we look for. Multiple synonyms because the master sheet
# has 30 / 31 / 32 / 33-column variants (researcher report).
_HEADER_HOSTNAME = ("device",)
_HEADER_PORT = ("port",)
_HEADER_MAKE = ("make",)
_HEADER_ROOM = ("room",)
_HEADER_RACK = ("rack",)
_HEADER_ULOC = ("u-loc", "uloc", "u loc")
_HEADER_TILE = ("tile",)
_HEADER_CABLED = ("cabled",)
_HEADER_LENGTH = ("length",)
_HEADER_COMMENT = ("comment", "comments")
_HEADER_TYPE = ("cable type",)
_HEADER_CABLE_ID = ("cable id", "cableid")
_HEADER_PP_A = ("pp a",)
_HEADER_PP_A_P = ("pp a p", "pp a  p")
_HEADER_PP_B = ("pp b",)
_HEADER_PP_B_P = ("pp b p", "pp b  p")
_HEADER_PP_C = ("pp c",)
_HEADER_PP_C_P = ("pp c p", "pp c  p")
_HEADER_PP_D = ("pp d",)
_HEADER_PP_D_P = ("pp d p", "pp d  p")


def _norm_header(s: str) -> str:
    return (s or "").strip().lower()


def _parse_tab_name_from_filename(filename: str) -> str:
    """Pull the human tab name out of a Google-Sheets CSV download.

    Google's exporter names files like
    "Master Patchplan FRA3 - NCG [10] CC2.csv" — keep the part after
    " - " (the tab name) and drop the .csv extension. Falls back to
    the bare stem if the convention doesn't apply.
    """
    stem = Path(filename).stem
    if " - " in stem:
        return stem.split(" - ", 1)[1].strip()
    return stem


def _row_field(row: list[str], idx: int) -> str:
    if idx < 0 or idx >= len(row):
        return ""
    return (row[idx] or "").strip()


def _parse_csv(path: Path, tab: str) -> list[Cable]:
    """Parse one downloaded CSV tab into a list of cables.

    Locates columns by header name on row 1 — robust against the 30 /
    31 / 32 / 33-col variants the master sheet ships with. Rows where
    both side-A and side-B device names are blank are treated as
    section dividers and skipped.
    """
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            rows = list(reader)
    except OSError:
        logger.exception("patchplan: failed to read %s", path)
        return []
    if not rows:
        return []
    header = [_norm_header(c) for c in rows[0]]

    def find_all(*needles: str) -> list[int]:
        out: list[int] = []
        for i, h in enumerate(header):
            if h in needles:
                out.append(i)
        return out

    device_idxs = find_all(*_HEADER_HOSTNAME)
    if len(device_idxs) < 2:
        # Either the header row is missing (Sheet16) or the export
        # caught a non-cable tab. Skip silently.
        logger.info("patchplan: %s has %d device columns, skipping",
                    path.name, len(device_idxs))
        return []
    side_a_idx, side_b_idx = device_idxs[0], device_idxs[1]

    def find_one(*needles: str, after: int = -1) -> int:
        for i, h in enumerate(header):
            if i <= after:
                continue
            if h in needles:
                return i
        return -1

    cabled_i = find_one(*_HEADER_CABLED)
    length_i = find_one(*_HEADER_LENGTH)
    comment_i = find_one(*_HEADER_COMMENT)
    type_i = find_one(*_HEADER_TYPE)
    # Cable ID: prefer the LAST one in the row (col AG on most tabs);
    # the first column is sometimes blank or polluted with stray text.
    cable_id_idxs = find_all(*_HEADER_CABLE_ID)
    cable_id_idx = cable_id_idxs[-1] if cable_id_idxs else 0

    # Side A block: port/make/room/rack/u-loc/tile between side_a_idx
    # and side_b_idx, picked by header.
    a_port_i = find_one(*_HEADER_PORT, after=side_a_idx)
    a_make_i = find_one(*_HEADER_MAKE, after=side_a_idx)
    a_room_i = find_one(*_HEADER_ROOM, after=side_a_idx)
    a_rack_i = find_one(*_HEADER_RACK, after=side_a_idx)
    a_uloc_i = find_one(*_HEADER_ULOC, after=side_a_idx)
    a_tile_i = find_one(*_HEADER_TILE, after=side_a_idx)
    # Constrain to "before side B" to avoid pulling side B columns.
    # locals() mutation doesn't work in Python — assign explicitly.
    if a_port_i >= side_b_idx: a_port_i = -1
    if a_make_i >= side_b_idx: a_make_i = -1
    if a_room_i >= side_b_idx: a_room_i = -1
    if a_rack_i >= side_b_idx: a_rack_i = -1
    if a_uloc_i >= side_b_idx: a_uloc_i = -1
    if a_tile_i >= side_b_idx: a_tile_i = -1

    # Side B block: same headers but after side_b_idx.
    b_port_i = find_one(*_HEADER_PORT, after=side_b_idx)
    b_make_i = find_one(*_HEADER_MAKE, after=side_b_idx)
    b_room_i = find_one(*_HEADER_ROOM, after=side_b_idx)
    b_rack_i = find_one(*_HEADER_RACK, after=side_b_idx)
    b_uloc_i = find_one(*_HEADER_ULOC, after=side_b_idx)
    b_tile_i = find_one(*_HEADER_TILE, after=side_b_idx)

    # Hops: PP A / B / C / D, with their ports.
    hop_specs = [
        ("PP A", _HEADER_PP_A, _HEADER_PP_A_P),
        ("PP B", _HEADER_PP_B, _HEADER_PP_B_P),
        ("PP C", _HEADER_PP_C, _HEADER_PP_C_P),
        ("PP D", _HEADER_PP_D, _HEADER_PP_D_P),
    ]
    hop_indexes: list[tuple[str, int, int]] = []
    for label, panel_keys, port_keys in hop_specs:
        # Find both panel and port columns within the side-A/B gap, then
        # assign: the one listed first is the panel, the other is the port.
        # Some tabs (e.g. FLEX2) export "PP C P" before "PP C" — handle
        # the swap rather than reading panel and port reversed.
        first_i = -1
        second_i = -1
        for i, h in enumerate(header):
            if i <= side_a_idx:
                continue
            if i >= side_b_idx:
                break
            if h in panel_keys and first_i == -1:
                first_i = i
            elif h in port_keys and first_i == -1:
                first_i = i
            elif h in panel_keys or h in port_keys:
                second_i = i
                break
        if first_i == -1:
            continue
        # Determine which index is panel vs port by checking which header
        # matches the panel_keys group.
        if header[first_i] in panel_keys:
            pi, po = first_i, second_i
        else:
            pi, po = second_i, first_i
        if pi == -1:
            continue
        if po != -1 and po >= side_b_idx:
            po = -1
        hop_indexes.append((label, pi, po))

    out: list[Cable] = []
    for r in rows[1:]:
        side_a = _row_field(r, side_a_idx)
        side_b = _row_field(r, side_b_idx)
        # Section dividers: both ends blank.
        if not side_a and not side_b:
            continue
        cable_id = _row_field(r, cable_id_idx)
        if not cable_id:
            # Try the first column too in case AG isn't populated.
            cable_id = _row_field(r, 0)
        if not cable_id:
            continue

        hops: list[CableHop] = []
        for label, pi, po in hop_indexes:
            panel = _row_field(r, pi)
            port = _row_field(r, po) if po >= 0 else ""
            if not panel or panel.startswith("---"):
                continue
            hops.append(CableHop(label=label, panel=panel, port=port))

        out.append(Cable(
            cable_id=cable_id,
            tab=tab,
            cabled=_row_field(r, cabled_i) if cabled_i >= 0 else "",
            cable_type=_row_field(r, type_i) if type_i >= 0 else "",
            length=_row_field(r, length_i) if length_i >= 0 else "",
            comment=_row_field(r, comment_i) if comment_i >= 0 else "",
            side_a=CableEnd(
                device=side_a,
                port=_row_field(r, a_port_i) if a_port_i >= 0 else "",
                make=_row_field(r, a_make_i) if a_make_i >= 0 else "",
                room=_row_field(r, a_room_i) if a_room_i >= 0 else "",
                rack=_row_field(r, a_rack_i) if a_rack_i >= 0 else "",
                u_loc=_row_field(r, a_uloc_i) if a_uloc_i >= 0 else "",
                tile=_row_field(r, a_tile_i) if a_tile_i >= 0 else "",
            ),
            side_b=CableEnd(
                device=side_b,
                port=_row_field(r, b_port_i) if b_port_i >= 0 else "",
                make=_row_field(r, b_make_i) if b_make_i >= 0 else "",
                room=_row_field(r, b_room_i) if b_room_i >= 0 else "",
                rack=_row_field(r, b_rack_i) if b_rack_i >= 0 else "",
                u_loc=_row_field(r, b_uloc_i) if b_uloc_i >= 0 else "",
                tile=_row_field(r, b_tile_i) if b_tile_i >= 0 else "",
            ),
            hops=hops,
        ))
    return out


# Tabs we don't need for the hostname lookup — inventory + legacy.
_SKIP_TABS = {
    "Device Inv", "17.1 Rack matrix", "PP Inv", "DB LEAFS",
    "NCG [25] CC6_OLD", "Sheet16",
    # TAP tabs use a different schema; surface them later if needed.
    "CC TAP [NCG7]", "VI TAP NCG [3-5, 8]",
}


class LocalCsvSource(PatchplanSource):
    """Reads master-patchplan tabs from a local directory of CSVs.

    Setup: in Google Sheets, ``File → Download → CSV`` for each tab.
    Drop the resulting files into the directory (default
    ``~/.widash/patchplan/``). Re-running the download replaces the
    file; ``revision_id`` notices via the file's mtime.
    """

    def __init__(self, directory: Path | None = None):
        # Resolve the directory in this priority order:
        # 1. Caller-provided path (tests, future callers)
        # 2. WIDASH_PATCHPLAN_DIR env var
        # 3. <repo>/patchplan/ — convenient for local development;
        #    the repo's .gitignore must keep the CSVs out of commits
        # 4. ~/.widash/patchplan/ — final fallback
        if directory is not None:
            self._dir = directory
        else:
            env = os.environ.get("WIDASH_PATCHPLAN_DIR")
            if env:
                self._dir = Path(env).expanduser()
            else:
                # backend/patchplan.py → repo root is two levels up.
                repo_dir = Path(__file__).resolve().parent.parent / "patchplan"
                if repo_dir.is_dir():
                    self._dir = repo_dir
                else:
                    self._dir = Path.home() / ".widash" / "patchplan"

    @property
    def directory(self) -> Path:
        return self._dir

    def revision_id(self) -> str:
        """Hash all CSV file mtimes + sizes — cheap and stable."""
        if not self._dir.exists():
            return "missing"
        parts: list[str] = []
        for p in sorted(self._dir.glob("*.csv")):
            try:
                st = p.stat()
                parts.append(f"{p.name}:{int(st.st_mtime)}:{st.st_size}")
            except OSError:
                continue
        return "|".join(parts) or "empty"

    def get_cables(self) -> list[Cable]:
        if not self._dir.exists():
            logger.info("patchplan: dir %s missing — no data", self._dir)
            return []
        cables: list[Cable] = []
        for p in sorted(self._dir.glob("*.csv")):
            tab = _parse_tab_name_from_filename(p.name)
            if tab in _SKIP_TABS:
                continue
            cables.extend(_parse_csv(p, tab))
        return cables


# ---------------------------------------------------------------- Index ----

def build_index(cables: list[Cable], revision: str) -> PatchplanIndex:
    by_host: dict[str, list[Cable]] = {}
    by_rack: dict[tuple[str, str], list[Cable]] = {}
    for c in cables:
        for end in (c.side_a, c.side_b):
            host = (end.device or "").strip().lower()
            if _is_indexable_hostname(host):
                by_host.setdefault(host, []).append(c)
            room = _norm_rack_token(end.room)
            rack = _norm_rack_token(end.rack)
            if room and rack:
                by_rack.setdefault((room, rack), []).append(c)
    return PatchplanIndex(
        cables=cables, by_host=by_host, by_rack=by_rack,
        revision=revision, fetched_at=time.time(),
    )


# ---------------------------------------------------------------- Cache ----

class PatchplanCache:
    """Polls a ``PatchplanSource`` and keeps the last good index in
    memory. Lookups are O(1); the poller only re-parses when the
    source's revision_id changes. Thread-safe enough for our usage:
    we do an atomic dict swap, no readers ever see a half-built index.
    """

    def __init__(self, source: PatchplanSource, poll_seconds: float = 180.0):
        self._source = source
        self._poll = poll_seconds
        self._index: Optional[PatchplanIndex] = None
        self._last_check = 0.0
        self._last_revision = ""

    def get(self) -> PatchplanIndex:
        now = time.time()
        if self._index is None or now - self._last_check >= self._poll:
            try:
                self._refresh_if_changed()
            except Exception:  # noqa: BLE001
                logger.exception("patchplan: refresh failed")
            self._last_check = now
        return self._index or build_index([], "missing")

    def force_refresh(self) -> PatchplanIndex:
        self._refresh_if_changed(force=True)
        self._last_check = time.time()
        return self._index or build_index([], "missing")

    def _refresh_if_changed(self, force: bool = False) -> None:
        rev = self._source.revision_id()
        if not force and rev == self._last_revision and self._index is not None:
            return
        cables = self._source.get_cables()
        self._index = build_index(cables, rev)
        self._last_revision = rev
        logger.info(
            "patchplan: indexed %d cables across %d hostnames (rev=%s)",
            len(cables), len(self._index.by_host),
            rev[:80] + "…" if len(rev) > 80 else rev,
        )

    @property
    def source(self) -> PatchplanSource:
        return self._source
