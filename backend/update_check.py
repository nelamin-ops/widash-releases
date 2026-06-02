"""Checks GitHub Releases API for a newer version of WiDash.

Runs a single HTTPS request to the public GitHub API, caches the result
for 1 hour so every dashboard poll doesn't hammer the API. Returns None
on any network / parse error so the frontend simply shows no banner.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

from .version import __version__, RELEASES_REPO

logger = logging.getLogger("widash.update")

_CACHE_TTL = 3600.0  # seconds

_cached_result: Optional[dict] = None
_cached_at: float = 0.0


def _parse_version(tag: str) -> tuple[int, ...]:
    """'v1.2' or '1.2' → (1, 2). Returns (0,) on parse failure."""
    tag = tag.lstrip("v").strip()
    try:
        return tuple(int(p) for p in tag.split("."))
    except ValueError:
        return (0,)


def get_update_info() -> dict:
    """Return a dict with keys: current, latest, url, update_available.

    Uses a module-level cache so repeated calls within the TTL window
    don't hit the network. Thread-safe enough for our single-worker
    uvicorn setup (no lock needed).
    """
    global _cached_result, _cached_at

    now = time.time()
    if _cached_result is not None and now - _cached_at < _CACHE_TTL:
        return _cached_result

    result = _fetch_latest()
    _cached_result = result
    _cached_at = now
    return result


def _fetch_latest() -> dict:
    base = {
        "current": __version__,
        "latest": __version__,
        "url": f"https://github.com/{RELEASES_REPO}/releases/latest",
        "update_available": False,
    }
    try:
        resp = httpx.get(
            f"https://api.github.com/repos/{RELEASES_REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json"},
            timeout=5.0,
            follow_redirects=True,
        )
        if resp.status_code == 404:
            # No releases published yet — not an error.
            return base
        resp.raise_for_status()
        data = resp.json()
        tag: str = data.get("tag_name", "")
        html_url: str = data.get("html_url", base["url"])
        if not tag:
            return base
        latest_ver = tag.lstrip("v")
        update_available = _parse_version(tag) > _parse_version(__version__)
        return {
            "current": __version__,
            "latest": latest_ver,
            "url": html_url,
            "update_available": update_available,
        }
    except Exception:
        logger.debug("update check failed", exc_info=True)
        return base
