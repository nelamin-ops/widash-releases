from datetime import datetime, timezone
from backend.models import (
    PrioBreakdown, StatusBucket, RmaTicket, ActivityEvent
)


def test_prio_breakdown_total():
    p = PrioBreakdown(Sev0=1, Sev1=2, Sev2=3, Sev3=4)
    assert p.total() == 10


def test_status_bucket_round_trip():
    b = StatusBucket(
        status="New", count=12, color="#60A5FA",
        prioBreakdown=PrioBreakdown(Sev0=1, Sev1=4, Sev2=5, Sev3=2),
        totalRuntimeSeconds=432000,
    )
    j = b.model_dump_json()
    parsed = StatusBucket.model_validate_json(j)
    assert parsed == b


def test_rma_ticket_gus_url_built():
    t = RmaTicket(
        id="a0a1234567890ABCD",
        name="W-12345",
        location="FRA2",
        priority="Sev0",
        status="In Progress",
        componentType="Disk",
        createdDate=datetime(2026, 5, 1, tzinfo=timezone.utc),
        assignee="@nelamin",
    )
    assert t.gusUrl == (
        "https://gus.lightning.force.com/lightning/r/"
        "Case/a0a1234567890ABCD/view"
    )


def test_activity_event_status_change():
    e = ActivityEvent(
        id="e1",
        ticketId="W-12345",
        ticketSfId="a0a1",
        type="status_change",
        timestamp=datetime(2026, 5, 18, 14, 32, tzinfo=timezone.utc),
        actor="@nelamin",
        fromStatus="New",
        toStatus="In Progress",
        location="FRA2",
    )
    assert e.commentText is None


def test_activity_event_comment_truncated():
    long = "x" * 500
    e = ActivityEvent(
        id="e2",
        ticketId="W-12345",
        ticketSfId="a0a1",
        type="comment",
        timestamp=datetime(2026, 5, 18, 14, 32, tzinfo=timezone.utc),
        actor="@nelamin",
        commentText=long,
        location="FRA2",
    )
    assert len(e.commentText) == 200
