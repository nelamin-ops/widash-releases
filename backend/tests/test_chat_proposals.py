import json

from backend.chat import (
    CASE_FIELD_BLACKLIST, ASSET_FIELD_BLACKLIST,
    _generate_proposal_id,
)


def test_blacklists_contain_structural_fields():
    for f in ("OwnerId", "RecordTypeId", "IsClosed", "IsDeleted",
              "CreatedById", "CreatedDate", "LastModifiedById",
              "LastModifiedDate", "SystemModstamp"):
        assert f in CASE_FIELD_BLACKLIST, f"{f} missing from CASE_FIELD_BLACKLIST"
    for f in ("OwnerId", "RecordTypeId", "CreatedById",
              "LastModifiedById", "SystemModstamp"):
        assert f in ASSET_FIELD_BLACKLIST, f"{f} missing from ASSET_FIELD_BLACKLIST"


def test_generate_proposal_id_format():
    pid = _generate_proposal_id()
    assert pid.startswith("p_")
    assert len(pid) == 8           # p_ + 6 hex
    assert all(c in "0123456789abcdef" for c in pid[2:])


from unittest.mock import MagicMock

from backend.chat import _run_tool


def _client_with_case():
    """Fake GusClient mit gerade genug Oberfläche für die Validator-
    Pfade in propose_case_patch."""
    sf = MagicMock()
    sf.query.return_value = {"records": [{
        "Id": "500AAAAAAAAAAAAAAA",
        "CaseNumber": "91886282",
        "AssetId": None,
    }]}
    # _describe_fields_by_name kommt aus case_detail; gepatcht im Test.
    client = MagicMock()
    client._sf = sf
    return client, sf


def test_propose_case_patch_blacklisted_field_rejected(monkeypatch):
    client, _ = _client_with_case()
    monkeypatch.setattr(
        "backend.chat.case_detail._describe_fields_by_name",
        lambda sf, sobj: {
            "OwnerId": {"name": "OwnerId", "updateable": True, "type": "reference"},
        },
    )
    out = _run_tool("propose_case_patch", {
        "case_id": "91886282",
        "changes": [{"sobject": "case", "apiName": "OwnerId", "value": "005x"}],
    }, [client])
    assert '"error"' in out
    assert "blacklisted" in out or "OwnerId" in out


def test_propose_case_patch_unknown_field_rejected(monkeypatch):
    client, _ = _client_with_case()
    monkeypatch.setattr(
        "backend.chat.case_detail._describe_fields_by_name",
        lambda sf, sobj: {},
    )
    out = _run_tool("propose_case_patch", {
        "case_id": "91886282",
        "changes": [{"sobject": "case", "apiName": "Frobnitz__c", "value": "x"}],
    }, [client])
    assert "unknown_field" in out or "unknown field" in out


def test_propose_case_patch_happy_path(monkeypatch):
    client, sf = _client_with_case()
    sf.query.return_value = {"records": [{
        "Id": "500AAAAAAAAAAAAAAA",
        "CaseNumber": "91886282",
        "AssetId": None,
    }]}
    monkeypatch.setattr(
        "backend.chat.case_detail._describe_fields_by_name",
        lambda sf, sobj: {
            "Status": {
                "name": "Status", "label": "Status",
                "type": "picklist", "updateable": True,
                "picklistValues": [
                    {"value": "Open", "active": True},
                    {"value": "Pending Closure", "active": True},
                ],
            },
        },
    )
    # get_case_detail returnt None → oldValue bleibt None, ok für Happy Path.
    monkeypatch.setattr(
        "backend.chat.case_detail.get_case_detail",
        lambda sf, case_id, asset_id_hint=None: None,
    )
    out = _run_tool("propose_case_patch", {
        "case_id": "91886282",
        "changes": [{"sobject": "case", "apiName": "Status", "value": "Pending Closure"}],
    }, [client])
    payload = json.loads(out)
    assert payload["kind"] == "case_patch_proposal"
    assert payload["caseNumber"] == "91886282"
    assert payload["proposalId"].startswith("p_")
    assert len(payload["changes"]) == 1
    assert payload["changes"][0]["apiName"] == "Status"
    assert payload["changes"][0]["newValue"] == "Pending Closure"
    assert payload["changes"][0]["label"] == "Status"


def test_propose_chatter_post_empty_body_rejected():
    client, _ = _client_with_case()
    out = _run_tool("propose_chatter_post", {
        "case_id": "91886282",
        "source": "chatter",
        "body": "   ",
    }, [client])
    assert "empty" in out or "invalid_body" in out


def test_propose_chatter_post_happy_path(monkeypatch):
    client, sf = _client_with_case()
    sf.query.return_value = {"records": [{
        "Id": "500AAAAAAAAAAAAAAA", "CaseNumber": "91886282",
    }]}
    out = _run_tool("propose_chatter_post", {
        "case_id": "91886282",
        "source": "chatter",
        "body": "Hardware drained, ready for vendor pickup.",
    }, [client])
    payload = json.loads(out)
    assert payload["kind"] == "chatter_post_proposal"
    assert payload["caseNumber"] == "91886282"
    assert payload["source"] == "chatter"
    assert "drained" in payload["body"]
    assert payload["proposalId"].startswith("p_")


def test_propose_chatter_post_invalid_source_rejected():
    client, sf = _client_with_case()
    sf.query.return_value = {"records": [{
        "Id": "500AAAAAAAAAAAAAAA", "CaseNumber": "91886282",
    }]}
    out = _run_tool("propose_chatter_post", {
        "case_id": "91886282",
        "source": "email",
        "body": "trying to write email",
    }, [client])
    assert "invalid_source" in out


def test_propose_chatter_edit_not_owner_rejected(monkeypatch):
    client, sf = _client_with_case()
    # Case lookup
    sf.query.side_effect = [
        {"records": [{"Id": "500AAAAAAAAAAAAAAA", "CaseNumber": "91886282"}]},
        # FeedItem lookup — CreatedById gehört nicht dem User
        {"records": [{
            "Id": "0D5XXXXXXXXXXXXXXX",
            "Body": "old body",
            "CreatedById": "005SOMEONE_ELSE",
            "ParentId": "500AAAAAAAAAAAAAAA",
        }]},
    ]
    client.get_current_user_info.return_value = {"id": "005MEMEMEMEMEMEMEME"}
    out = _run_tool("propose_chatter_edit", {
        "case_id": "91886282",
        "entry_id": "0D5XXXXXXXXXXXXXXX",
        "new_body": "edited body",
    }, [client])
    assert "not_owner" in out


def test_propose_chatter_edit_happy_path(monkeypatch):
    client, sf = _client_with_case()
    sf.query.side_effect = [
        {"records": [{"Id": "500AAAAAAAAAAAAAAA", "CaseNumber": "91886282"}]},
        {"records": [{
            "Id": "0D5XXXXXXXXXXXXXXX",
            "Body": "alt",
            "CreatedById": "005MEMEMEMEMEMEMEME",
            "ParentId": "500AAAAAAAAAAAAAAA",
        }]},
    ]
    client.get_current_user_info.return_value = {"id": "005MEMEMEMEMEMEMEME"}
    out = _run_tool("propose_chatter_edit", {
        "case_id": "91886282",
        "entry_id": "0D5XXXXXXXXXXXXXXX",
        "new_body": "neu",
    }, [client])
    payload = json.loads(out)
    assert payload["kind"] == "chatter_edit_proposal"
    assert payload["entryKind"] == "post"
    assert payload["oldBody"] == "alt"
    assert payload["newBody"] == "neu"
    assert payload["proposalId"].startswith("p_")


from backend.chat import _system_prompt


def test_system_prompt_mentions_proposal_tools():
    p = _system_prompt(["FRA3"])
    # Drei Tool-Namen + die "niemals" Regel müssen drinstehen.
    assert "propose_case_patch" in p
    assert "propose_chatter_post" in p
    assert "propose_chatter_edit" in p
    assert "Niemals" in p or "niemals" in p


def test_system_prompt_encourages_batched_tool_calls():
    p = _system_prompt(["FRA3"])
    # Hinweis muss explizit "selben Turn" oder "Batch" enthalten,
    # damit das Modell den Wink versteht.
    assert "Batch" in p or "batch" in p
    assert "selben Turn" in p or "im selben Turn" in p


def test_propose_chatter_post_with_mentions(monkeypatch):
    client, sf = _client_with_case()
    # First query: case lookup; second: User WHERE Id IN (...)
    sf.query.side_effect = [
        {"records": [{"Id": "500AAAAAAAAAAAAAAA", "CaseNumber": "91886282"}]},
        {"records": [
            {"Id": "005000000000000001", "Name": "Max Mustermann"},
            {"Id": "005000000000000002", "Name": "Alex Tester"},
        ]},
    ]
    out = _run_tool("propose_chatter_post", {
        "case_id": "91886282",
        "source": "chatter",
        "body": "kannst du dir das anschauen?",
        "mentions": ["005000000000000001", "005000000000000002"],
    }, [client])
    payload = json.loads(out)
    assert payload["kind"] == "chatter_post_proposal"
    assert payload["mentions"] == [
        {"userId": "005000000000000001", "displayName": "Max Mustermann"},
        {"userId": "005000000000000002", "displayName": "Alex Tester"},
    ]


# --- History trimming / truncation limits ---------------------------------

from backend.chat import _trim_history, _truncate_for_model


def _msgs(n):
    """Build n alternating user/assistant turns starting with user."""
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"}
        for i in range(n)
    ]


def test_trim_history_under_limit_is_unchanged():
    h = _msgs(5)
    out = _trim_history(h, 120)
    assert out == h
    assert out is not h            # returns a copy, never mutates input


def test_trim_history_keeps_most_recent():
    h = _msgs(10)                  # m0..m9 (m6 is user: 6 % 2 == 0)
    out = _trim_history(h, 4)
    # Keeps the last 4; m6 already starts on a user turn, no extra drop.
    assert [m["content"] for m in out] == ["m6", "m7", "m8", "m9"]
    assert out[0]["role"] == "user"


def test_trim_history_first_message_is_always_user():
    # Even when the trimmed window starts on an assistant turn, the
    # result must begin with a user message (Anthropic API requirement).
    h = _msgs(6)
    out = _trim_history(h, 3)      # window m3(assistant) m4 m5
    assert out[0]["role"] == "user"


def test_trim_history_all_assistant_returns_empty():
    h = [{"role": "assistant", "content": "x"}]
    assert _trim_history(h, 120) == []


def test_truncate_for_model_caps_long_output():
    out = _truncate_for_model({"big": "x" * 50000})
    assert len(out) <= 12000 + len(" …[truncated]")
    assert out.endswith("…[truncated]")


def test_truncate_for_model_short_output_intact():
    out = _truncate_for_model({"ok": "small"})
    assert out == '{"ok": "small"}'
    assert "truncated" not in out
