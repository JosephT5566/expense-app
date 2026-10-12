from copy import deepcopy

import pytest
from conftest import CONTEXT, RAW, REQUEST_ID, ROW

from semantic_entry.contracts import parse_completed_result, parse_request
from semantic_entry.normalize import normalize_extraction


def test_defaults():
    expense = normalize_extraction(RAW, CONTEXT)["expense"]
    assert expense == {
        k: v
        for k, v in ROW.items()
        if k not in ("id", "meta", "created_at", "updated_at")
    }


@pytest.mark.parametrize(
    "kind,ts",
    [
        ("yesterday", "2026-02-27T16:00:00.000Z"),
        ("day_before_yesterday", "2026-02-26T16:00:00.000Z"),
    ],
)
def test_month_boundary(kind, ts):
    assert (
        normalize_extraction({**RAW, "date": {"kind": kind, "value": None}}, CONTEXT)[
            "expense"
        ]["ts"]
        == ts
    )


def test_split():
    result = normalize_extraction(
        {
            **RAW,
            "scope": "household",
            "hasSharedIntent": True,
            "splitMemberIds": ["b", "a"],
        },
        CONTEXT,
    )
    assert result["expense"]["shares_json"] == {
        "a@example.test": 426,
        "b@example.test": 425,
    }
    assert result["expense"]["is_settled"] is False


@pytest.mark.parametrize(
    "patch",
    [{"amount": v} for v in (None, 0, -1, 1.5, 2**53, True, "851")]
    + [
        {"payerId": "unknown"},
        {"payerId": "b"},
        {"note": " "},
        {"currency": "USD"},
        {"unsupportedReason": "refund"},
        {"unsupportedReason": "multiple"},
        {"categoryId": "unknown"},
        {"date": {"kind": "absolute", "value": "2026-02-30"}},
        {"date": {"kind": "absolute", "value": "2026-03-02"}},
        {"date": {"kind": "bogus", "value": None}},
        {"date": {"kind": "today", "value": "2026-03-01"}},
        {"hasSharedIntent": True},
        {"scope": "household"},
        {"splitMemberIds": ["a", "b"]},
        {"scope": "household", "splitMemberIds": ["a", "a"]},
        {"scope": "household", "splitMemberIds": ["a", "unknown"]},
        {"extra": True},
    ],
)
def test_rejections(patch):
    assert normalize_extraction({**RAW, **patch}, CONTEXT)["status"] == "rejected"


def test_configuration_and_ambiguity():
    assert normalize_extraction(RAW, {**CONTEXT, "otherCategoryId": "absent"})[
        "issues"
    ] == [{"field": "categoryId", "code": "configuration"}]
    assert (
        normalize_extraction(
            {**RAW, "categoryId": CONTEXT["otherCategoryId"]},
            {**CONTEXT, "otherCategoryId": ""},
        )["status"]
        == "valid"
    )
    assert normalize_extraction({**RAW, "payerId": "__ambiguous__"}, CONTEXT)[
        "issues"
    ] == [{"field": "members", "code": "ambiguous_member"}]
    ctx = deepcopy(CONTEXT)
    ctx["members"].append({"id": "a", "email": "c@example.test", "name": "丙"})
    assert normalize_extraction({**RAW, "payerId": "a"}, ctx)["status"] == "rejected"


def test_request_unicode_contract():
    assert (
        len(
            parse_request({"requestId": REQUEST_ID, "text": " " + "🍜" * 500 + " "})[
                "text"
            ]
        )
        == 500
    )
    assert (
        parse_request({"requestId": REQUEST_ID, "text": "\ufeffe\u0301\ufeff"})["text"]
        == "é"
    )
    for text in ("🍜" * 501, "e\u0301" * 250 + "x", " "):
        with pytest.raises(ValueError):
            parse_request({"requestId": REQUEST_ID, "text": text})
    for request in (
        {"requestId": "bad", "text": "午餐100"},
        {"requestId": REQUEST_ID, "text": "午餐100", "userId": "a"},
        {"requestId": REQUEST_ID, "text": "午餐100", "hash": "x"},
    ):
        with pytest.raises(ValueError):
            parse_request(request)


def test_nullable_fields_cannot_be_missing():
    for key in RAW:
        raw = {k: v for k, v in RAW.items() if k != key}
        assert normalize_extraction(raw, CONTEXT)["issues"] == [
            {"field": "extraction", "code": "invalid"}
        ]


@pytest.mark.parametrize(
    "patch",
    [
        {"amount": True},
        {"shares_json": {"a@example.test": 1}},
        {"currency": "USD"},
        {"is_settled": 1},
        {"ts": "bad"},
        {"meta": None},
        {"extra": True},
    ],
)
def test_invalid_snapshot(patch):
    with pytest.raises(ValueError):
        parse_completed_result({"expense": {**ROW, **patch}, "replayed": True})
