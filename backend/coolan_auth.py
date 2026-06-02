"""On-disk Coolan auth storage.

Coolan has its own SSO and refuses Salesforce session tokens, so the user
pastes their browser-side bearer/cookie once. We persist it under
``~/.widash/coolan_auth.json`` so a backend restart doesn't lose it.

The format is intentionally tiny:

    {
        "token": "Bearer eyJhbGciOi...",   # contents of the Authorization header
        "cookie": "session=abc; ...",      # optional Cookie header
        "savedAt": "2026-05-20T10:00:00Z",
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
_AUTH_FILE = _AUTH_DIR / "coolan_auth.json"


class CoolanAuth(TypedDict, total=False):
    token: str
    cookie: str
    savedAt: str
    note: str


def load() -> Optional[CoolanAuth]:
    """Return the persisted auth or None if not set / unreadable."""
    if not _AUTH_FILE.exists():
        return None
    try:
        with _AUTH_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and (data.get("token") or data.get("cookie")):
            return data  # type: ignore[return-value]
        return None
    except (OSError, json.JSONDecodeError):
        return None


def save(token: Optional[str], cookie: Optional[str], note: str = "") -> CoolanAuth:
    """Persist a new auth record. Empty strings are stored as missing."""
    _AUTH_DIR.mkdir(parents=True, exist_ok=True)
    payload: CoolanAuth = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "note": note,
    }
    if token:
        payload["token"] = token.strip()
    if cookie:
        payload["cookie"] = cookie.strip()
    tmp = _AUTH_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, _AUTH_FILE)
    # Be polite about secrets-on-disk: 0600 user-only.
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
