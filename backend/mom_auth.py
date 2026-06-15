"""On-disk mom.dmz auth storage.

mom.dmz uses Salesforce SSO; the backend can't initiate that flow, so the
user copies their browser cookie header once (most importantly the
``ring-session`` cookie that authenticates Argus calls) and we persist it
under ``~/.widash/mom_auth.json`` so a backend restart doesn't lose it.

Format mirrors ``coolan_auth`` deliberately:

    {
        "cookie": "ring-session=...; sfdc_lv2=...; ...",
        "savedAt": "2026-06-11T13:18:00Z",
        "note": "free-form, e.g. browser used"
    }
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

_AUTH_DIR = Path.home() / ".widash"
_AUTH_FILE = _AUTH_DIR / "mom_auth.json"


class MomAuth(TypedDict, total=False):
    cookie: str
    savedAt: str
    note: str


def load() -> Optional[MomAuth]:
    """Return the persisted auth or None if not set / unreadable."""
    if not _AUTH_FILE.exists():
        return None
    try:
        with _AUTH_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("cookie"):
            return data  # type: ignore[return-value]
        return None
    except (OSError, json.JSONDecodeError):
        return None


def save(cookie: Optional[str], note: str = "") -> MomAuth:
    """Persist a new auth record. Empty strings are stored as missing."""
    _AUTH_DIR.mkdir(parents=True, exist_ok=True)
    payload: MomAuth = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "note": note,
    }
    if cookie:
        payload["cookie"] = cookie.strip()
    tmp = _AUTH_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, _AUTH_FILE)
    try:
        os.chmod(_AUTH_FILE, 0o600)
    except OSError:
        pass
    return payload


def clear() -> None:
    try:
        _AUTH_FILE.unlink()
    except FileNotFoundError:
        pass
