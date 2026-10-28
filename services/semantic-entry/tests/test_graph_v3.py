from copy import deepcopy
from unittest.mock import AsyncMock, Mock, call

import pytest
from conftest import CONTEXT, REQUEST, REQUEST_ID, ROW
from fakes_v3 import DRAFT_ID, IMAGE_REQUEST, PATH, client_draft, make_setup, raw_draft

from semantic_entry.contracts import parse_response_v3
from semantic_entry.drafts import normalize_draft
from semantic_entry.errors import SemanticError
from semantic_entry.graph import input_hash, input_hash_v4
from semantic_entry.graph_v3 import invoke_v3


async def run(request, deps, **kwargs):
    result = await invoke_v3(request, "synthetic", deps, **kwargs)
    assert parse_response_v3(result) == result
    return result


async def test_text_uses_v2_hash_and_replays_v2_snapshot():
    deps, adapter, _ = make_setup()
    request = {**REQUEST, "action": "analyze"}
    adapter.lookup_completed.return_value = {"expense": ROW, "replayed": True}
    r = await run(request, deps)
    assert r["expenses"] == [ROW] and r["replayed"]
    adapter.lookup_completed.assert_awaited_once_with(REQUEST_ID, input_hash(REQUEST))
    assert input_hash_v4(request) == input_hash(REQUEST)
    adapter.consume_quota.assert_not_awaited()


async def test_image_order_single_rpc_persisting_once_and_replay():
    deps, adapter, store = make_setup()
    order = Mock()
    for name in (
        "authenticate",
        "load_context",
        "lookup_completed_v3",
        "consume_quota",
        "persist_expense",
    ):
        order.attach_mock(getattr(adapter, name), name)
    for name in ("metadata", "download"):
        setattr(store, name, AsyncMock(side_effect=getattr(store, name)))
        order.attach_mock(getattr(store, name), name)
    order.attach_mock(deps.extract_drafts, "extract")
    persisting = AsyncMock()
    r = await run(IMAGE_REQUEST, deps, on_persisting=persisting)
    assert r["expenses"] == [ROW] and not r["replayed"]
    assert [c[0] for c in order.mock_calls] == [
        "authenticate",
        "load_context",
        "metadata",
        "lookup_completed_v3",
        "consume_quota",
        "download",
        "extract",
        "persist_expense",
    ]
    digest = input_hash_v4(IMAGE_REQUEST, [{"path": PATH, "generation": "17"}])
    assert call.lookup_completed_v3(REQUEST_ID, digest) in order.mock_calls
    adapter.persist_expenses.assert_not_awaited()
    persisting.assert_awaited_once()
    adapter.lookup_completed_v3.return_value = {"expenses": [ROW], "replayed": True}
    order.reset_mock()
    r = await run(IMAGE_REQUEST, deps)
    assert r["replayed"]
    assert [c[0] for c in order.mock_calls] == [
        "authenticate",
        "load_context",
        "metadata",
        "lookup_completed_v3",
    ]


@pytest.mark.parametrize("count,incomplete", [(2, False), (1, True)])
async def test_multiple_or_incomplete_never_persists(count, incomplete):
    deps, adapter, _ = make_setup()
    r = raw_draft()
    r["draftId"] = None
    if incomplete:
        r["note"].update(value=None, state="explicit_null")
    deps.extract_drafts.return_value["raw"]["drafts"] = [
        deepcopy(r) for _ in range(count)
    ]
    persisting = AsyncMock()
    result = await run(IMAGE_REQUEST, deps, on_persisting=persisting)
    assert result["status"] == "drafts"
    assert result["reason"] == ("multiple" if count > 1 else "incomplete")
    adapter.persist_expense.assert_not_awaited()
    adapter.persist_expenses.assert_not_awaited()
    persisting.assert_not_awaited()


@pytest.mark.parametrize(
    "count,nonreceipt,code",
    [(0, [0], "not_a_receipt"), (0, [], "missing"), (21, [], "too_many_drafts")],
)
async def test_empty_and_too_many_drafts(count, nonreceipt, code):
    deps, adapter, _ = make_setup()
    deps.extract_drafts.return_value["raw"] = {
        "drafts": [raw_draft() for _ in range(count)],
        "nonReceiptImages": nonreceipt,
    }
    r = await run(IMAGE_REQUEST, deps)
    assert r["status"] == "rejected" and r["issues"][0]["code"] == code
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize("action", ["analyze", "revise"])
async def test_missing_provider_configuration(action):
    deps, _, _ = make_setup()
    deps.extract_drafts = None
    request = (
        IMAGE_REQUEST
        if action == "analyze"
        else {
            "requestId": REQUEST_ID,
            "action": "revise",
            "text": "修正",
            "drafts": [client_draft()],
        }
    )
    with pytest.raises(SemanticError, match="provider_configuration"):
        await run(request, deps)


async def test_revise_revalidates_client_no_images_and_always_drafts():
    deps, adapter, store = make_setup()
    d = client_draft()
    d["categoryId"]["value"] = "tampered"
    d["payerEmail"]["value"] = "outsider@example.test"
    d["date"]["value"] = "2026-03-02"
    d.update(status="complete", issues=[])
    request = {
        "requestId": REQUEST_ID,
        "action": "revise",
        "text": "修正",
        "drafts": [d],
    }
    r = await run(request, deps)
    assert store.calls == []
    payload = deps.extract_drafts.call_args.args[0]
    assert payload["images"] == [] and payload["mode"] == "revise"
    sent = payload["drafts"][0]
    assert "status" not in sent and "issues" not in sent
    assert sent["categoryId"]["value"] is None
    assert sent["payerEmail"]["value"] is None
    assert sent["date"]["value"] == CONTEXT["today"]
    assert r["status"] == "drafts" and r["drafts"][0]["status"] == "complete"
    assert r["reason"] == "incomplete" and r["drafts"][0]["updated"]
    adapter.consume_quota.assert_awaited_once()
    adapter.persist_expense.assert_not_awaited()
    adapter.persist_expenses.assert_not_awaited()


@pytest.mark.parametrize(
    "ids",
    [
        [None],
        [DRAFT_ID],
        ["44444444-4444-4444-8444-444444444444"],
        [DRAFT_ID, DRAFT_ID],
    ],
)
async def test_revise_identity_updated_and_merged_from(ids):
    deps, _, _ = make_setup()
    d = client_draft()
    d["mergedFrom"] = ["55555555-5555-4555-8555-555555555555"]
    drafts = []
    for identifier in ids:
        r = raw_draft()
        r["draftId"] = identifier
        drafts.append(r)
    deps.extract_drafts.return_value["raw"]["drafts"] = drafts
    request = {
        "requestId": REQUEST_ID,
        "action": "revise",
        "text": "確認",
        "drafts": [d],
    }
    if len(ids) == 2 or ids[0] not in (None, DRAFT_ID):
        with pytest.raises(SemanticError, match="provider_invalid"):
            await run(request, deps)
    else:
        result = (await run(request, deps))["drafts"][0]
        if ids[0] is None:
            assert result["draftId"] != DRAFT_ID and result["updated"] is True
        else:
            assert "updated" not in result
            assert result["mergedFrom"] == d["mergedFrom"]


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("categoryId", "tampered", "invalid"),
        ("payerEmail", "unknown@example.test", "unknown_member"),
        ("date", "2026-03-02", "future_date"),
        ("currency", "USD", "non_twd"),
        ("note", None, "missing"),
        ("scope", "household", "invalid"),
    ],
)
async def test_commit_strict_rejection_without_writes(field, value, code):
    deps, adapter, store = make_setup()
    d = client_draft()
    d[field]["value"] = value
    callback = AsyncMock()
    r = await run(
        {"requestId": REQUEST_ID, "action": "commit", "drafts": [d]},
        deps,
        on_persisting=callback,
    )
    assert r["status"] == "rejected"
    assert any(i["code"] == code for i in r["draftIssues"][0]["issues"])
    adapter.consume_quota.assert_not_awaited()
    adapter.persist_expenses.assert_not_awaited()
    callback.assert_not_awaited()
    deps.extract_drafts.assert_not_awaited()
    assert store.calls == []


@pytest.mark.parametrize("count", [1, 2])
async def test_commit_batch_even_one_and_replay_without_quota_or_model(count):
    deps, adapter, store = make_setup()
    adapter.persist_expenses.return_value["expenses"] = [ROW] * count
    callback = AsyncMock()
    request = {
        "requestId": REQUEST_ID,
        "action": "commit",
        "drafts": [client_draft() for _ in range(count)],
    }
    r = await run(request, deps, on_persisting=callback)
    assert len(r["expenses"]) == count and r["metadata"] is None
    callback.assert_awaited_once()
    adapter.persist_expenses.assert_awaited_once()
    adapter.persist_expense.assert_not_awaited()
    adapter.consume_quota.assert_not_awaited()
    deps.extract_drafts.assert_not_awaited()
    assert store.calls == []
    adapter.lookup_completed_v3.return_value = {
        "expenses": [ROW] * count,
        "replayed": True,
    }
    assert (await run(request, deps))["replayed"]
    assert adapter.persist_expenses.await_count == 1


@pytest.mark.parametrize(
    "error", [TimeoutError(), SemanticError(504, "database_error", True)]
)
async def test_batch_timeout_is_uncertain(error):
    deps, adapter, _ = make_setup()
    adapter.persist_expenses.side_effect = error
    with pytest.raises(SemanticError) as exc:
        await run(
            {"requestId": REQUEST_ID, "action": "commit", "drafts": [client_draft()]},
            deps,
        )
    assert exc.value.code == "persist_uncertain" and exc.value.uncertain


@pytest.mark.parametrize(
    "raw",
    [
        {},
        {"drafts": [{}], "nonReceiptImages": []},
        {"drafts": [], "nonReceiptImages": [9]},
    ],
)
async def test_bad_model_shape_is_provider_invalid(raw):
    deps, _, _ = make_setup()
    deps.extract_drafts.return_value["raw"] = raw
    with pytest.raises(SemanticError, match="provider_invalid"):
        await run(IMAGE_REQUEST, deps)


@pytest.mark.parametrize("action", ["analyze", "revise", "commit"])
async def test_v3_future_reference_date_rejected_before_quota(action):
    deps, adapter, _ = make_setup()
    request = (
        {**IMAGE_REQUEST, "referenceDate": "2026-03-02"}
        if action == "analyze"
        else {
            "requestId": REQUEST_ID,
            "action": action,
            "drafts": [client_draft()],
            "referenceDate": "2026-03-02",
            **({"text": "修正"} if action == "revise" else {}),
        }
    )
    with pytest.raises(SemanticError, match="invalid_request"):
        await run(request, deps)
    adapter.consume_quota.assert_not_awaited()


async def test_changed_generation_changes_hash_before_quota():
    deps, adapter, store = make_setup()
    original = input_hash_v4(IMAGE_REQUEST, [{"path": PATH, "generation": "17"}])
    store.add(PATH, generation="18")

    async def lookup(identifier, digest):
        assert digest != original
        assert digest == input_hash_v4(
            IMAGE_REQUEST, [{"path": PATH, "generation": "18"}]
        )
        raise SemanticError(409, "conflict")

    adapter.lookup_completed_v3.side_effect = lookup
    with pytest.raises(SemanticError, match="conflict"):
        await run(IMAGE_REQUEST, deps)
    adapter.consume_quota.assert_not_awaited()
    assert store.calls == [("metadata", PATH)]


async def test_partial_nonreceipt_images_keep_remaining_receipt():
    deps, adapter, store = make_setup()
    second = "uploads/a/other.jpg"
    store.add(second)
    deps.extract_drafts.return_value["raw"]["nonReceiptImages"] = [1]
    r = await run({**IMAGE_REQUEST, "images": [PATH, second]}, deps)
    assert r["status"] == "created" and len(r["expenses"]) == 1
    adapter.consume_quota.assert_awaited_once()


async def test_image_path_ownership_precedes_all_store_calls():
    deps, adapter, store = make_setup()
    with pytest.raises(SemanticError, match="image_forbidden_path"):
        await run({**IMAGE_REQUEST, "images": [PATH, "uploads/b/other.jpg"]}, deps)
    assert store.calls == []
    adapter.lookup_completed_v3.assert_not_awaited()
    adapter.consume_quota.assert_not_awaited()


@pytest.mark.parametrize("rejected", [False, True])
async def test_text_v3_needs_input_and_rejected_use_contract(rejected):
    deps, _, _ = make_setup()
    deps.extract_entry.return_value["raw"].update(
        {"unsupportedReason": "refund"} if rejected else {"amount": None}
    )
    r = await run({**REQUEST, "action": "analyze"}, deps)
    assert r["status"] == ("rejected" if rejected else "needs_input")


async def test_image_quota_denial_prevents_download_and_model():
    deps, adapter, store = make_setup()
    adapter.consume_quota.return_value = False
    with pytest.raises(SemanticError, match="quota_exceeded"):
        await run(IMAGE_REQUEST, deps)
    assert store.calls == [("metadata", PATH)]
    deps.extract_drafts.assert_not_awaited()


@pytest.mark.parametrize("source", ["text", "user"])
@pytest.mark.parametrize("confidence", [0.3, 0.7])
async def test_image_supplemental_amount_confidence_gate(source, confidence):
    deps, adapter, _ = make_setup()
    deps.extract_drafts.return_value["raw"]["drafts"][0]["amount"].update(
        source=source, confidence=confidence
    )
    result = await run({**IMAGE_REQUEST, "text": "金額 851 元"}, deps)
    if confidence < 0.7:
        assert result["status"] == "drafts" and result["reason"] == "incomplete"
        assert {"field": "amount", "code": "low_confidence"} in result["drafts"][0][
            "issues"
        ]
        adapter.persist_expense.assert_not_awaited()
    else:
        assert result["status"] == "created"
        adapter.persist_expense.assert_awaited_once()
    adapter.persist_expenses.assert_not_awaited()


def marked_original(marker):
    raw = raw_draft()
    raw["date"].update(
        value=None if marker == "unreadable" else "2026-03-05",
        state="unrecognized" if marker == "unreadable" else "recognized",
    )
    original = normalize_draft(raw, deepcopy(CONTEXT))
    assert original["date"]["defaulted"] == marker
    return original


def raw_from_original(original):
    raw = raw_draft()
    for key in raw.keys() - {"draftId", "originalAmountText"}:
        raw[key] = {k: v for k, v in original[key].items() if k != "defaulted"}
    return raw


async def revise_result(original, revised, deps):
    deps.extract_drafts.return_value["raw"]["drafts"] = [revised]
    return (
        await run(
            {
                "requestId": REQUEST_ID,
                "action": "revise",
                "text": "改分類或備註",
                "drafts": [original],
            },
            deps,
        )
    )["drafts"][0]


@pytest.mark.parametrize("marker", ["unreadable", "future"])
async def test_revise_other_field_keeps_date_marker(marker):
    deps, _, _ = make_setup()
    original = marked_original(marker)
    revised = raw_draft()
    revised["date"] = {k: v for k, v in original["date"].items() if k != "defaulted"}
    revised["categoryId"].update(
        value=CONTEXT["categories"][-1]["id"], source="text", confidence=0.9
    )
    d = await revise_result(original, revised, deps)
    assert d["draftId"] == DRAFT_ID
    assert d["date"] == original["date"]
    assert d["date"]["defaulted"] == marker
    assert ({"field": "date", "code": "date_defaulted"} in d["issues"]) == (
        marker == "unreadable"
    )
    assert d["status"] == ("incomplete" if marker == "unreadable" else "complete")


@pytest.mark.parametrize("marker", ["unreadable", "future"])
@pytest.mark.parametrize("source", ["image", "default"])
async def test_revise_same_date_source_drift_keeps_marker(marker, source):
    deps, _, _ = make_setup()
    original = marked_original(marker)
    revised = raw_from_original(original)
    revised["date"].update(source=source, confidence=None)
    d = await revise_result(original, revised, deps)
    assert d["date"] == original["date"]
    assert "updated" not in d


@pytest.mark.parametrize("same_day", [False, True])
async def test_revise_explicit_date_correction_or_confirmation_clears_marker(same_day):
    deps, _, _ = make_setup()
    original = marked_original("unreadable")
    revised = raw_from_original(original)
    revised["date"].update(
        value=original["date"]["value"] if same_day else "2026-02-27",
        source="user",
        confidence=None,
    )
    d = await revise_result(original, revised, deps)
    assert d["date"]["defaulted"] is None
    assert {"field": "date", "code": "date_defaulted"} not in d["issues"]
    assert d["status"] == "complete" and d["updated"]


@pytest.mark.parametrize(
    "source,confidence", [("image", None), ("image", 0.9), ("default", None)]
)
async def test_revise_note_keeps_service_defaults(source, confidence):
    deps, _, _ = make_setup()
    raw = raw_draft()
    raw["currency"]["value"] = None
    raw["date"].update(source="default", confidence=None)
    original = normalize_draft(raw, deepcopy(CONTEXT))
    revised = raw_from_original(original)
    revised["note"].update(value="晚餐", source="text")
    fields = ("currency", "scope", "payerEmail", "splitMemberEmails", "date")
    for field in fields:
        revised[field].update(source=source, confidence=confidence)
    d = await revise_result(original, revised, deps)
    for field in fields:
        assert d[field] == original[field]
        assert d[field]["source"] == "default"
    assert d["note"]["value"] == "晚餐"
    assert d["status"] == "complete" and d["updated"]


async def test_revise_text_currency_change_is_not_preserved_as_default():
    deps, _, _ = make_setup()
    raw = raw_draft()
    raw["currency"]["value"] = None
    original = normalize_draft(raw, deepcopy(CONTEXT))
    revised = raw_from_original(original)
    revised["currency"].update(value="USD", source="text", confidence=0.9)
    d = await revise_result(original, revised, deps)
    assert d["currency"]["value"] == "USD" and d["currency"]["source"] == "text"
    assert {"field": "currency", "code": "non_twd"} in d["issues"]
    assert d["status"] == "incomplete"


async def test_revise_uses_revalidated_original_for_date_provenance_and_updated():
    deps, _, _ = make_setup()
    original = client_draft()
    original["date"].update(value="2026-03-05", defaulted=None)
    revised = raw_from_original(original)
    revised["date"].update(value=CONTEXT["today"], source="image", confidence=0.9)
    d = await revise_result(original, revised, deps)
    sent = deps.extract_drafts.call_args.args[0]["drafts"][0]
    assert sent["date"]["defaulted"] == "future"
    assert d["date"] == sent["date"]
    assert d["status"] == "complete"
    assert "updated" not in d
