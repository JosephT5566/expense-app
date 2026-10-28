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
