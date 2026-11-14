from copy import deepcopy

import pytest
from conftest import CONTEXT, RAW, REQUEST, REQUEST_ID, ROW

from semantic_entry.contracts import parse_completed_result, parse_request
from semantic_entry.graph import invoke
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
    assert normalize_extraction(RAW, {**CONTEXT, "categories": []})["issues"] == [
        {"field": "categoryId", "code": "configuration"}
    ]
    assert normalize_extraction({**RAW, "payerId": "__ambiguous__"}, CONTEXT)[
        "issues"
    ] == [{"field": "payerId", "code": "ambiguous_member"}]
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


def test_non_defaultable_fields_cannot_be_missing():
    for key in RAW:
        if key in ("payerId", "scope", "splitMemberIds"):
            continue
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


@pytest.mark.parametrize("scope", ["personal", "household"])
def test_database_amount_capacity(scope):
    raw = {**RAW, "scope": scope}
    if scope == "household":
        raw.update(hasSharedIntent=True, splitMemberIds=["a", "b"])
    valid = normalize_extraction({**raw, "amount": 9_999_999_999}, CONTEXT)
    assert valid["status"] == "valid"
    assert sum(valid["expense"]["shares_json"].values()) == 9_999_999_999
    for amount in (10_000_000_000, 2**53 - 1):
        rejected = normalize_extraction({**raw, "amount": amount}, CONTEXT)
        assert rejected == {
            "status": "rejected",
            "issues": [{"field": "amount", "code": "invalid"}],
        }


def household(**patch):
    return {
        **RAW,
        "scope": "household",
        "hasSharedIntent": True,
        "splitMemberIds": ["a", "b"],
        **patch,
    }


@pytest.mark.parametrize(
    "identifier", ["b", "B@EXAMPLE.TEST", "lionheart", "LIONHEART"]
)
def test_unique_nickname_email_or_id(identifier):
    ctx = deepcopy(CONTEXT)
    ctx["members"][1]["name"] = "lionheart"
    result = normalize_extraction(household(payerId=identifier), ctx)
    assert result["status"] == "valid"
    assert result["expense"]["payer_email"] == "b@example.test"


@pytest.mark.parametrize("identifier", ["lion", "lionhearts", "老公", "老婆", "室友"])
def test_unknown_names_never_fuzzy_match_or_default(identifier):
    ctx = deepcopy(CONTEXT)
    ctx["members"][1]["name"] = "lionheart"
    result = normalize_extraction(household(payerId=identifier), ctx)
    assert result["status"] == "rejected"
    assert {"field": "payerId", "code": "unknown_member"} in result["issues"]


def test_duplicate_case_insensitive_nickname_is_ambiguous():
    ctx = deepcopy(CONTEXT)
    ctx["members"][0]["name"] = "lionheart"
    ctx["members"][1]["name"] = "LIONHEART"
    result = normalize_extraction(household(payerId="LionHeart"), ctx)
    assert {"field": "payerId", "code": "ambiguous_member"} in result["issues"]


def test_repro_341_difference_28_has_only_repairable_split_issue():
    ctx = deepcopy(CONTEXT)
    ctx["members"][1]["name"] = "lionheart"
    result = normalize_extraction(
        household(
            note="早餐麥當勞",
            amount=341,
            payerId="lionheart",
            splitMemberIds=["我", "lionheart"],
            splitDifference=28,
        ),
        ctx,
    )
    assert result["issues"] == [{"field": "shares", "code": "custom_required"}]
    assert result["splitContext"] == {
        "amount": 341,
        "emails": ["a@example.test", "b@example.test"],
        "difference": 28,
    }
    assert result["candidateExpense"]["payer_email"] == "b@example.test"


@pytest.mark.parametrize(
    "patch,shares",
    [
        (
            {"amount": 340, "splitDifference": 28},
            {"a@example.test": 184, "b@example.test": 156},
        ),
        (
            {"amount": 850, "splitRatio": {"甲": 7, "乙": 3}},
            {"a@example.test": 595, "b@example.test": 255},
        ),
        (
            {"amount": 341, "shares": {"甲": 185, "乙": 156}},
            {"a@example.test": 185, "b@example.test": 156},
        ),
        (
            {"amount": 341, "shares": {"a": 0, "b": 341}},
            {"a@example.test": 0, "b@example.test": 341},
        ),
    ],
)
def test_exact_custom_integer_shares(patch, shares):
    result = normalize_extraction(household(**patch), CONTEXT)
    assert result["status"] == "valid"
    assert result["expense"]["shares_json"] == shares


@pytest.mark.parametrize(
    "shares",
    [
        {"a": 184.5, "b": 156.5},
        {"a": -1, "b": 342},
        {"a": 184, "b": 156},
        {"a": 185, "outsider@example.test": 156},
        {"a": 341},
        {"a": 185, "A@EXAMPLE.TEST": 156},
    ],
)
def test_custom_shares_never_round_or_accept_invalid_members(shares):
    result = normalize_extraction(household(amount=341, shares=shares), CONTEXT)
    assert result["status"] == "rejected"
    assert any(i["field"] in ("shares", "members") for i in result["issues"])


def test_legacy_unequal_split_is_repairable_and_refund_remains_terminal():
    assert normalize_extraction(household(unsupportedReason="unequal_split"), CONTEXT)[
        "issues"
    ] == [{"field": "shares", "code": "custom_required"}]
    assert normalize_extraction(household(unsupportedReason="refund"), CONTEXT)[
        "issues"
    ] == [{"field": "intent", "code": "unsupported"}]


def test_missing_payer_defaults_to_caller_and_explicit_list_does_not_add_caller():
    ctx = deepcopy(CONTEXT)
    ctx["members"].append({"id": "c", "email": "c@example.test", "name": "丙"})
    result = normalize_extraction(household(splitMemberIds=["乙", "丙"]), ctx)
    assert result["expense"]["payer_email"] == "a@example.test"
    assert set(result["expense"]["shares_json"]) == {"b@example.test", "c@example.test"}


def test_legacy_non_equal_intent_never_silently_becomes_personal():
    result = normalize_extraction(
        {**RAW, "unsupportedReason": "unequal_split"}, CONTEXT
    )
    assert result["status"] == "rejected"
    assert result["issues"] == [{"field": "splitMemberIds", "code": "ambiguous_member"}]


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
        {"shares": {"a": True, "b": 340}},
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
async def test_malformed_optional_split_fields_reject_without_graph_crash(patch, setup):
    raw = household(amount=341, **patch)
    assert normalize_extraction(raw, CONTEXT) == {
        "status": "rejected",
        "issues": [{"field": "extraction", "code": "invalid"}],
    }
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = raw
    result = await invoke(REQUEST, "synthetic-token", deps)
    assert result == {
        "status": "rejected",
        "requestId": REQUEST["requestId"],
        "issues": [{"field": "extraction", "code": "invalid"}],
    }
    adapter.persist_expense.assert_not_called()


@pytest.mark.parametrize("key", ["shares", "splitRatio"])
@pytest.mark.parametrize(
    "duplicate,code", [(False, "unknown_member"), (True, "ambiguous_member")]
)
def test_custom_map_unknown_and_duplicate_names_are_identity_questions_first(
    key, duplicate, code
):
    ctx = deepcopy(CONTEXT)
    if duplicate:
        ctx["members"][0]["name"] = "lionheart"
        ctx["members"][1]["name"] = "LIONHEART"
    result = normalize_extraction(
        household(amount=341, **{key: {"a": 185, "lionheart": 156}}), ctx
    )
    assert result == {
        "status": "rejected",
        "issues": [{"field": "members", "code": code}],
    }
