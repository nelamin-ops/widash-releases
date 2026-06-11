from datetime import datetime, timezone
from unittest.mock import MagicMock
from fastapi.testclient import TestClient
from backend.main import app, get_gus_client, get_gus_clients
from backend.models import (
    ActivityEvent, PrioBreakdown, RmaActiveResponse,
    RmaTicket, StatusBucket,
)

NOW = datetime(2026, 5, 18, 16, 0, tzinfo=timezone.utc)


def make_fake_client():
    fake = MagicMock()
    fake._report_id = "00OEE000001HkkD2AS"
    fake.get_active_rmas.return_value = RmaActiveResponse(
        total=2,
        buckets=[
            StatusBucket(
                status="New", count=1, color="#60A5FA",
                prioBreakdown=PrioBreakdown(Sev0=0, Sev1=0, Sev2=1, Sev3=0),
                totalRuntimeSeconds=86400,
            ),
            StatusBucket(
                status="In Progress", count=1, color="#A78BFA",
                prioBreakdown=PrioBreakdown(Sev0=1, Sev1=0, Sev2=0, Sev3=0),
                totalRuntimeSeconds=172800,
            ),
        ],
        fetchedAt=NOW,
    )
    fake.get_tickets_for_status.return_value = [
        RmaTicket(
            id="a0a1", name="W-100", location="FRA1", priority="Sev0",
            status="In Progress", componentType="Disk",
            createdDate=NOW, assignee="@nelamin",
        )
    ]
    fake.get_activity_events.return_value = [
        ActivityEvent(
            id="e1", ticketId="W-100", ticketSfId="a0a1",
            type="status_change", timestamp=NOW, actor="@nelamin",
            fromStatus="New", toStatus="In Progress", location="FRA1",
        )
    ]
    return fake


def test_get_active(monkeypatch):
    fake = make_fake_client()
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.get("/api/rma/active")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert len(body["buckets"]) == 2
    app.dependency_overrides.clear()


def test_get_active_by_status(monkeypatch):
    fake = make_fake_client()
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.get("/api/rma/active/In%20Progress")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "In Progress"
    assert len(body["tickets"]) == 1
    assert body["tickets"][0]["gusUrl"].endswith("/a0a1/view")
    app.dependency_overrides.clear()


def test_get_activity_default(monkeypatch):
    fake = make_fake_client()
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.get("/api/activity")
    assert r.status_code == 200
    fake.get_activity_events.assert_called_with(
        activity_type="all", limit=200, locations=None, include_bots=False,
    )
    app.dependency_overrides.clear()


def test_get_activity_with_filter(monkeypatch):
    fake = make_fake_client()
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.get("/api/activity?type=status_change&limit=50")
    assert r.status_code == 200
    fake.get_activity_events.assert_called_with(
        activity_type="status_change", limit=50, locations=None,
        include_bots=False,
    )
    app.dependency_overrides.clear()


def test_post_refresh_clears_cache(monkeypatch):
    fake = make_fake_client()
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.post("/api/refresh")
    assert r.status_code == 200
    assert r.json() == {"status": "refreshed"}
    app.dependency_overrides.clear()


def test_auth_error_returns_401(monkeypatch):
    fake = MagicMock()
    fake._report_id = "00OEE000001HkkD2AS"
    from simple_salesforce.exceptions import SalesforceExpiredSession
    fake.get_active_rmas.side_effect = SalesforceExpiredSession(
        url="x", status=401, resource_name="x", content=[],
    )
    app.dependency_overrides[get_gus_client] = lambda: fake
    app.dependency_overrides[get_gus_clients] = lambda: [fake]
    client = TestClient(app)
    r = client.get("/api/rma/active")
    assert r.status_code == 401
    assert r.json()["error"] == "auth_expired"
    app.dependency_overrides.clear()
