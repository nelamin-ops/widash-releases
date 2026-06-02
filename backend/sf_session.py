"""Live Salesforce session helper.

The original ``start.sh`` exported the access token from ``sf org display``
into the backend's environment ONCE at start-up. That meant every token
refresh required a backend restart. This module replaces that flow:
``sf org display --json`` is invoked on demand and the result is cached
for a short window. When the token rotates we tell the caller so it can
rebuild any per-token clients.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("widash.sf")

# Re-resolve the sf CLI session at most every CACHE_TTL seconds so we
# don't shell out on every API request. The token itself usually lives
# ~2h, so 60s of staleness is fine.
CACHE_TTL = 60.0


@dataclass(frozen=True)
class SfSession:
    instance_url: str
    access_token: str
    username: str


class SfSessionError(RuntimeError):
    """Raised when we can't talk to the sf CLI or it returns no session."""


_cached: Optional[SfSession] = None
_cached_at: float = 0.0


def _run_sf_org_display() -> dict:
    """Invoke ``sf org display --json`` and return the result dict."""
    sf_bin = shutil.which("sf")
    if not sf_bin:
        raise SfSessionError(
            "sf CLI not found on PATH. Install Salesforce CLI and run "
            "`sf org login web`."
        )
    try:
        proc = subprocess.run(
            [sf_bin, "org", "display", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
            # Newer sf-CLI versions redact accessToken by default.
            # SF_TEMP_SHOW_SECRETS=true is the official workaround until
            # Salesforce ships a stable machine-readable auth command.
            env={**__import__("os").environ, "SF_TEMP_SHOW_SECRETS": "true"},
        )
    except subprocess.TimeoutExpired as e:
        raise SfSessionError("sf org display timed out") from e
    if proc.returncode != 0:
        raise SfSessionError(
            f"sf org display failed (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:300]}"
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise SfSessionError(
            f"sf org display returned non-JSON output: {e}"
        ) from e
    return payload


def get_session(force: bool = False) -> SfSession:
    """Return the current sf-CLI session.

    Cached for CACHE_TTL seconds. Pass ``force=True`` to bust the cache —
    useful right after the user re-ran ``sf org login web``.
    """
    global _cached, _cached_at
    now = time.monotonic()
    if not force and _cached and (now - _cached_at) < CACHE_TTL:
        return _cached

    payload = _run_sf_org_display()
    result = payload.get("result") or {}
    instance_url = result.get("instanceUrl") or ""
    access_token = result.get("accessToken") or ""
    username = result.get("username") or ""
    if not instance_url or not access_token:
        raise SfSessionError(
            "sf org display returned no active session. "
            "Run `sf org login web`."
        )
    session = SfSession(
        instance_url=instance_url,
        access_token=access_token,
        username=username,
    )
    _cached = session
    _cached_at = now
    return session


def invalidate_cache() -> None:
    """Drop the cached session so the next call re-reads sf-CLI."""
    global _cached, _cached_at
    _cached = None
    _cached_at = 0.0
