from copy import deepcopy

import pytest
from conftest import CONTEXT
from fakes_v3 import client_draft, raw_draft

from semantic_entry.contracts import parse_draft_v3
from semantic_entry.drafts import (
    draft_issues,
    expense_from_draft,
    normalize_draft,
    parse_raw_extraction,
)
from semantic_entry.errors import SemanticError
from semantic_entry.normalize import MAX_EXPENSE_AMOUNT, normalize_extraction


def normalized(patch=None):
    r = raw_draft()
    for key, fields in (patch or {}).items():
        r[key].update(fields)
    d = normalize_draft(r, deepcopy(CONTEXT))
    assert parse_draft_v3(d) == d
    return d


@pytest.mark.parametrize(
    "state", ["recognized", "unrecognized", "missing", "explicit_null"]
)
def test_four_states_preserved(state):
    d = normalized(
        {
            "note": {
                "state": state,
                "value": None if state == "explicit_null" else "午餐",
            }
        }
    )
    assert d["note"]["state"] == state


@pytest.mark.parametrize(
    "confidence,complete,code",
    [
        (0.69, False, "low_confidence"),
        (0.7, True, None),
        (None, False, "missing_confidence"),
    ],
)
def test_image_confidence_gate(confidence, complete, code):
    d = normalized({"amount": {"confidence": confidence}})
    assert (d["status"] == "complete") == complete
    if code:
        assert {"field": "amount", "code": code} in d["issues"]


@pytest.mark.parametrize("source", ["text", "default", "user"])
@pytest.mark.parametrize("confidence", [None, 0.01, 0.69, 0.7])
def test_other_sources_ignore_confidence(source, confidence):
    d = normalized({"amount": {"source": source, "confidence": confidence}})
    low = confidence is not None and confidence < 0.7
    assert d["status"] == ("incomplete" if low else "complete")
    if low:
        assert {"field": "amount", "code": "low_confidence"} in d["issues"]


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), -1, 2, True, "bad"])
def test_invalid_confidence_becomes_null(confidence):
    assert (
        normalized({"amount": {"confidence": confidence}})["amount"]["confidence"]
        is None
    )


@pytest.mark.parametrize(
    "value,defaulted,complete",
    [
        (None, "unreadable", False),
        ("2026-02-30", "unreadable", False),
        ("2026-03-02", "future", True),
        ("2026-03-01", None, True),
    ],
)
def test_date_defaults_and_taiwan_boundary(value, defaulted, complete):
    d = normalized({"date": {"value": value}})
    assert d["date"]["value"] == CONTEXT["today"]
    assert d["date"]["defaulted"] == defaulted
    assert (d["status"] == "complete") == complete
    if complete:
        assert expense_from_draft(d, CONTEXT)["ts"] == "2026-02-28T16:00:00.000Z"


@pytest.mark.parametrize(
    "amount,expected",
    [
        (99.01, 100),
        (0, None),
        (-1, None),
        (MAX_EXPENSE_AMOUNT + 1, None),
        pytest.param(10**1000, None, id="oversized-integer"),
        ("99", None),
        (float("inf"), None),
    ],
)
def test_rounding_and_amount_limits(amount, expected):
    d = normalized({"amount": {"value": amount}})
    assert d["amount"]["value"] == expected
    if expected is None:
        assert d["amount"]["state"] == "unrecognized"
    elif amount == 99.01:
        assert d["originalAmount"] == {"text": "99.01", "currency": "TWD"}


def test_original_amount_text_and_foreign_currency_preserved():
    r = raw_draft()
    r["originalAmountText"] = "$99.01"
    r["amount"]["value"] = 99.01
    r["currency"]["value"] = "usd"
    d = normalize_draft(r, CONTEXT)
    assert d["currency"]["value"] == "USD"
    assert d["originalAmount"] == {"text": "$99.01", "currency": "USD"}
    assert {"field": "currency", "code": "non_twd"} in d["issues"]


def test_defaults_note_and_invalid_category():
    d = normalized(
        {
            "note": {"value": " x " + "a" * 250},
            "currency": {"value": None},
            "categoryId": {"value": "invented"},
        }
    )
    assert len(d["note"]["value"]) == 200
    assert d["categoryId"]["value"] is None
    assert {"field": "categoryId", "code": "invalid"} in d["issues"]
    assert d["currency"]["source"] == "default"
    assert d["scope"]["value"] == "personal"


def test_text_household_and_split_matches_v2():
    from conftest import RAW

    d = normalized(
        {
            "scope": {
                "value": "household",
                "source": "text",
                "confidence": None,
                "state": "recognized",
            },
            "splitMemberEmails": {
                "value": ["b@example.test", "a@example.test", "b@example.test"],
                "state": "recognized",
            },
        }
    )
    assert d["status"] == "complete"
    expense = expense_from_draft(d, CONTEXT)
    v2 = normalize_extraction(
        {
            **RAW,
            "scope": "household",
            "hasSharedIntent": True,
            "splitMemberIds": ["b", "a"],
        },
        CONTEXT,
    )
    assert (
        expense["shares_json"]
        == v2["expense"]["shares_json"]
        == {"a@example.test": 426, "b@example.test": 425}
    )


@pytest.mark.parametrize(
    "patch,field,code",
    [
        (
            {"payerEmail": {"value": "unknown@example.test"}},
            "payerEmail",
            "unknown_member",
        ),
        ({"payerEmail": {"value": "b@example.test"}}, "payerEmail", "invalid"),
        (
            {
                "scope": {"value": "household"},
                "splitMemberEmails": {"value": ["a@example.test"]},
            },
            "splitMemberEmails",
            "invalid",
        ),
        (
            {
                "scope": {"value": "household"},
                "splitMemberEmails": {
                    "value": ["unknown@example.test", "a@example.test"]
                },
            },
            "splitMemberEmails",
            "unknown_member",
        ),
    ],
)
def test_members_gate(patch, field, code):
    assert {"field": field, "code": code} in normalized(patch)["issues"]


def test_commit_only_values_ignores_all_provenance():
    d = client_draft()
    for field in (
        "note",
        "amount",
        "date",
        "currency",
        "categoryId",
        "scope",
        "payerEmail",
    ):
        d[field].update(state="unrecognized", confidence=None, source="image")
    d["date"]["defaulted"] = "unreadable"
    assert draft_issues(d, CONTEXT, commit=True) == []


@pytest.mark.parametrize(
    "patch", [{}, {"drafts": {}}, {"nonReceiptImages": [-1]}, {"extra": True}]
)
def test_raw_shape_rejected(patch):
    r = {"drafts": [raw_draft()], "nonReceiptImages": []}
    if not patch:
        r["drafts"][0]["note"].pop("source")
    else:
        r.update(patch)
    with pytest.raises(SemanticError, match="provider_invalid"):
        parse_raw_extraction(r, 1)


@pytest.mark.parametrize(
    "identifier", ["b", "B@EXAMPLE.TEST", "lionheart", "LIONHEART"]
)
def test_receipt_unique_nickname_email_id_resolution(identifier):
    ctx = deepcopy(CONTEXT)
    ctx["members"][1]["name"] = "lionheart"
    raw = raw_draft()
    raw["scope"].update(value="household", state="recognized")
    raw["payerEmail"].update(value=identifier, state="recognized")
    raw["splitMemberEmails"].update(value=["我", "lionheart"], state="recognized")
    d = normalize_draft(raw, ctx)
    assert d["payerEmail"]["value"] == "b@example.test"
    assert d["splitMemberEmails"]["value"] == ["a@example.test", "b@example.test"]
    assert d["status"] == "complete"


@pytest.mark.parametrize(
    "name,code",
    [
        ("lion", "unknown_member"),
        ("lionheart", "ambiguous_member"),
        ("老婆", "unknown_member"),
    ],
)
def test_receipt_unknown_ambiguous_and_relationship_names(name, code):
    ctx = deepcopy(CONTEXT)
    ctx["members"][0]["name"] = "lionheart"
    ctx["members"][1]["name"] = "LIONHEART"
    raw = raw_draft()
    raw["scope"].update(value="household", state="recognized")
    raw["payerEmail"].update(value=name, state="recognized")
    raw["splitMemberEmails"].update(value=["a@example.test", name], state="recognized")
    d = normalize_draft(raw, ctx)
    assert d["payerEmail"]["value"] is None
    assert {"field": "payerEmail", "code": code} in d["issues"]
    assert {"field": "splitMemberEmails", "code": code} in d["issues"]


@pytest.mark.parametrize(
    "patch,expected",
    [
        (
            {"shares": {"甲": 600, "乙": 251}},
            {"a@example.test": 600, "b@example.test": 251},
        ),
        ({"splitDifference": 29}, {"a@example.test": 440, "b@example.test": 411}),
        ({"shares": {"a": 0, "b": 851}}, {"a@example.test": 0, "b@example.test": 851}),
    ],
)
def test_receipt_custom_shares_resolve_and_persist(patch, expected):
    raw = raw_draft()
    raw["scope"].update(value="household", state="recognized")
    raw["splitMemberEmails"].update(value=["甲", "乙"], state="recognized")
    raw.update(patch)
    d = normalize_draft(raw, CONTEXT)
    assert d["status"] == "complete"
    assert d["shares"] == expected
    assert expense_from_draft(d, CONTEXT)["shares_json"] == expected
    assert draft_issues(d, CONTEXT, commit=True) == []


@pytest.mark.parametrize(
    "shares",
    [
        {"a": -1, "b": 852},
        {"a": 600, "b": 250},
        {"a": 600.5, "b": 250.5},
        {"a": 600, "outsider@example.test": 251},
    ],
)
def test_receipt_invalid_shares_stay_incomplete(shares):
    raw = raw_draft()
    raw["scope"].update(value="household", state="recognized")
    raw["splitMemberEmails"].update(value=["a", "b"], state="recognized")
    raw["shares"] = shares
    d = normalize_draft(raw, CONTEXT)
    assert d["status"] == "incomplete"
    assert any(i["field"] in ("shares", "splitMemberEmails") for i in d["issues"])


def test_receipt_difference_needs_integer_choice():
    raw = raw_draft()
    raw["amount"]["value"] = 341
    raw["scope"].update(value="household", state="recognized")
    raw["splitMemberEmails"].update(value=["a", "b"], state="recognized")
    raw["splitDifference"] = 28
    d = normalize_draft(raw, CONTEXT)
    assert d["issues"] == [{"field": "shares", "code": "custom_required"}]


def test_commit_revalidates_custom_sum_and_allowed_members():
    d = client_draft()
    d["shares"] = {"a@example.test": 850}
    assert {"field": "shares", "code": "invalid"} in draft_issues(
        d, CONTEXT, commit=True
    )
    d["shares"] = {"outsider@example.test": 851}
    assert {"field": "splitMemberEmails", "code": "unknown_member"} in draft_issues(
        d, CONTEXT, commit=True
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"splitDifference": "28"},
        {"splitDifference": True},
        {"splitDifference": float("nan")},
        {"splitDifference": float("inf")},
        {"splitDifference": []},
        {"shares": []},
        {"shares": "185/156"},
        {"shares": {"a": True}},
        {"shares": {"a": float("nan")}},
        {"shares": {"a": "185"}},
        {"shares": {1: 341}},
        {"shares": {" ": 341}},
        {"splitRatio": [7, 3]},
        {"splitRatio": {"a": False}},
        {"splitRatio": {"a": float("inf")}},
        {"splitRatio": {"a": "7"}},
    ],
)
def test_receipt_malformed_optional_split_fields_are_provider_errors(patch):
    raw = raw_draft()
    raw.update(patch)
    with pytest.raises(SemanticError, match="provider_invalid"):
        parse_raw_extraction({"drafts": [raw], "nonReceiptImages": []}, 1)


@pytest.mark.parametrize("key", ["shares", "splitRatio"])
@pytest.mark.parametrize(
    "duplicate,code", [(False, "unknown_member"), (True, "ambiguous_member")]
)
def test_receipt_custom_map_names_need_member_resolution_before_split(
    key, duplicate, code
):
    ctx = deepcopy(CONTEXT)
    if duplicate:
        ctx["members"][0]["name"] = "lionheart"
        ctx["members"][1]["name"] = "LIONHEART"
    raw = raw_draft()
    raw["scope"].update(value="household", state="recognized")
    raw["splitMemberEmails"].update(value=["a", "b"], state="recognized")
    raw[key] = {"a": 600, "lionheart": 251}
    result = normalize_draft(raw, ctx)
    assert result["issues"] == [{"field": "splitMemberEmails", "code": code}]
