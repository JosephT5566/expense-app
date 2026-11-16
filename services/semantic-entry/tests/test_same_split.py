"""Historical relationships must be selected and computed by the backend."""

from copy import deepcopy

import pytest
from conftest import CONTEXT, RAW, REQUEST

A = "a@example.test"
B = "b@example.test"


def row(amount=100, shares=None, ts="2026-02-28T16:00:00Z"):
    return {
        "scope": "household",
        "ts": ts,
        "amount": amount,
        "shares_json": shares or {A: 50, B: 50},
    }


def raw(amount=100, members=None):
    return {
        **deepcopy(RAW),
        "amount": amount,
        "scope": "household",
        "hasSharedIntent": True,
        "splitMemberIds": members or ["a", "b"],
        "shares": {"untrusted-model-id": amount},
    }


def prepare(items, rows):
    from semantic_entry.same_split import prepare_history

    return prepare_history(items, rows, CONTEXT)


def test_equal_uses_new_amount_and_exact_member_set():
    items, confirmation = prepare(
        [raw(101)], [row(), row(shares={A: 50, "c@example.test": 50})]
    )
    assert items[0]["shares"] == {A: 51, B: 50}
    assert confirmation is None


@pytest.mark.parametrize(
    "amount,expected",
    [(100, {A: 70, B: 30}), (200, {A: 140, B: 60}), (102, {A: 71, B: 31})],
)
def test_custom_requires_confirmation_and_only_exact_conversion(amount, expected):
    items, confirmation = prepare([raw(amount)], [row(shares={A: 70, B: 30})])
    assert items[0]["shares"] == expected
    assert confirmation["historicalShares"] == expected


def test_unsafe_conversion_is_custom_required_for_entire_receipt():
    items, confirmation = prepare([raw(200), raw(101)], [row(shares={A: 70, B: 30})])
    assert confirmation is None
    assert all(i["shares"] == {} for i in items)


@pytest.mark.parametrize(
    "rows", [[], [row(shares={A: 100})], [row(), row(shares={A: 60, B: 40})]]
)
def test_no_match_or_tied_latest_cannot_guess(rows):
    items, confirmation = prepare([raw()], rows)
    assert items[0]["shares"] == {} and confirmation is None


@pytest.mark.parametrize(
    "members", [["a", "unknown"], ["a", "__ambiguous__"], ["a", "a"]]
)
def test_unresolved_or_duplicate_members_cannot_use_history(members):
    items, confirmation = prepare([raw(members=members)], [row()])
    assert items[0]["shares"] == {} and confirmation is None


def test_no_members_cannot_inherit_members_from_tool():
    item = raw()
    item["splitMemberIds"] = None
    items, confirmation = prepare([item], [row()])
    assert items[0]["splitMemberIds"] is None and items[0]["shares"] == {}


def test_latest_matching_row_and_one_relation_for_all_items():
    rows = [row(shares={A: 70, B: 30}), row(ts="2026-02-27T16:00:00Z")]
    items, confirmation = prepare([raw(100), raw(200)], rows)
    assert [i["shares"] for i in items] == [{A: 70, B: 30}, {A: 140, B: 60}]
    assert confirmation is not None


def test_receipt_inconsistent_members_blocks_every_item():
    items, _ = prepare([raw(), raw(members=["a", "unknown"])], [row()])
    assert all(i["shares"] == {} for i in items)


def test_historical_options_revalidated_with_fresh_relation():
    from semantic_entry.clarification import apply_answers, clarification_result
    from semantic_entry.normalize import normalize_extraction

    items, split = prepare([raw()], [row(shares={A: 70, B: 30})])
    validation = {
        "issues": [{"field": "shares", "code": "custom_required"}],
        "splitContext": split,
    }
    first = clarification_result(validation, REQUEST, CONTEXT)
    assert first["status"] == "needs_input" and first["purpose"] == "split"
    chosen = next(o for o in first["options"] if o["id"].startswith("history:"))
    request = {
        **REQUEST,
        "history": [
            {
                "question": first["question"],
                "questionId": first["questionId"],
                "answer": chosen["label"],
                "optionId": chosen["id"],
            }
        ],
    }
    adjusted, trusted, _ = apply_answers(items[0], request, CONTEXT, historical=split)
    assert trusted
    assert normalize_extraction(adjusted, CONTEXT)["expense"]["shares_json"] == {
        A: 70,
        B: 30,
    }
    _, changed = prepare([raw()], [row(shares={A: 60, B: 40})])
    assert not apply_answers(items[0], request, CONTEXT, historical=changed)[1]


def test_backend_keeps_batch_ceiling_even_for_single_receipt():
    # Draft SQL single RPC allows 9_007_199_254_740_991, batch allows 9_999_999_999.
    # The backend deliberately keeps the smaller normalization ceiling for both.
    from semantic_entry.normalize import MAX_EXPENSE_AMOUNT, normalize_extraction

    assert MAX_EXPENSE_AMOUNT == 9_999_999_999
    assert (
        normalize_extraction(raw(MAX_EXPENSE_AMOUNT + 1), CONTEXT)["status"]
        == "rejected"
    )


def test_zero_share_member_keeps_exact_ratio_for_three_people():
    from semantic_entry.same_split import prepare_history

    ctx = deepcopy(CONTEXT)
    ctx["members"].append({"id": "c", "name": "丙", "email": "c@example.test"})
    shares = {A: 70, B: 30, "c@example.test": 0}
    items, confirmation = prepare_history(
        [raw(200, ["a", "b", "c"])], [row(shares=shares)], ctx
    )
    assert items[0]["shares"] == {A: 140, B: 60, "c@example.test": 0}
    assert confirmation is not None


def test_invalid_latest_row_cannot_make_an_older_row_the_latest_match():
    items, confirmation = prepare(
        [raw()],
        [row(amount=101, shares={A: 70.5, B: 30.5}), row(ts="2026-02-27T16:00:00Z")],
    )
    assert items[0]["shares"] == {} and confirmation is None
