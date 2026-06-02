"""Coolan SSO automation via Playwright.

The Coolan UI sits behind a Keycloak realm that itself sits behind
Salesforce SSO. The dashboard pastes the user's bearer token once via
the UI; this module is the *automatic* fallback: when the saved token
is rejected, we fire up a persistent Chromium profile, navigate to
Coolan, and let it complete the SSO chain. The very first run shows
the browser so the user can do MFA interactively; subsequent runs
re-use the persisted profile and stay headless.

The token comes out of the browser's localStorage, where Coolan's
SPA stores it after the OIDC callback. We then save it through the
existing ``coolan_auth`` helper so the rest of the backend keeps
working unchanged.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, TypedDict

from . import coolan_auth

logger = logging.getLogger("widash.coolan_browser")

_PROFILE_DIR = Path.home() / ".widash" / "coolan_browser"
_COOLAN_URL = (
    "https://coolan.sfproxy.controltelemetry.aws-esvc1-useast2.aws.sfdc.cl"
    "/app/search"
)
# Coolan stores its OIDC token under a Keycloak realm key. The realm
# name is in the JWT iss field: …/realms/coolan, so the localStorage
# key is keycloak's standard format.
_LOCAL_STORAGE_KEYS = (
    "kc-token",
    "keycloak-token",
    "coolan-token",
    "access_token",
)


class RefreshResult(TypedDict, total=False):
    ok: bool
    token: str
    error: str
    needs_interaction: bool


def _extract_bearer(page) -> Optional[str]:
    """Try a handful of likely localStorage keys for the bearer token."""
    for key in _LOCAL_STORAGE_KEYS:
        value = page.evaluate(
            f"() => window.localStorage.getItem({key!r})"
        )
        if not value:
            continue
        # Some keys store JSON like {"token":"…","refresh":"…"}, others
        # the bare bearer string.
        if value.startswith("{"):
            import json
            try:
                parsed = json.loads(value)
                token = parsed.get("token") or parsed.get("access_token")
                if token:
                    return token
            except json.JSONDecodeError:
                continue
        elif value.startswith("ey"):  # JWT
            return value
    # Fallback: scan all localStorage entries for a JWT-looking value.
    snapshot = page.evaluate(
        "() => Object.fromEntries("
        "Object.keys(window.localStorage).map(k => [k, window.localStorage.getItem(k)])"
        ")"
    )
    for v in snapshot.values():
        if isinstance(v, str) and v.count(".") == 2 and v.startswith("ey"):
            return v
    return None


def refresh(headless: bool = True, timeout_ms: int = 60_000) -> RefreshResult:
    """Run the SSO flow once and persist the resulting token.

    On the first call (or after the persisted profile expires) Chromium
    will land on a Salesforce login page that requires manual MFA. Pass
    ``headless=False`` so the user can complete it; the next call can
    use ``headless=True``.
    """
    try:
        from playwright.sync_api import (
            sync_playwright, TimeoutError as PWTimeoutError,
        )
    except ImportError as e:
        return {
            "ok": False,
            "error": f"Playwright not installed: {e}",
        }

    _PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        try:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(_PROFILE_DIR),
                headless=headless,
                timeout=timeout_ms,
            )
        except Exception as e:
            return {
                "ok": False,
                "error": f"Failed to launch Chromium: {e}",
            }

        try:
            page = ctx.new_page()
            try:
                page.goto(_COOLAN_URL, timeout=timeout_ms, wait_until="networkidle")
            except PWTimeoutError:
                # Could mean we landed on an MFA page that's waiting on
                # the user. Bail with a hint.
                return {
                    "ok": False,
                    "needs_interaction": True,
                    "error": (
                        "Coolan/SSO didn't reach an idle state in time. "
                        "Re-run with headless=false to complete MFA "
                        "interactively."
                    ),
                }

            token = _extract_bearer(page)
            if not token:
                # Give the SPA a beat to settle, then try once more.
                page.wait_for_timeout(2_000)
                token = _extract_bearer(page)
            if not token:
                return {
                    "ok": False,
                    "needs_interaction": True,
                    "error": (
                        "No bearer token found in localStorage. "
                        "If this is the first run, complete the SF "
                        "login + MFA in the visible browser window."
                    ),
                }

            coolan_auth.save(
                token=f"Bearer {token}" if not token.lower().startswith("bearer ") else token,
                cookie=None,
                note="Auto-refreshed via Playwright",
            )
            return {"ok": True, "token": token}
        finally:
            ctx.close()
