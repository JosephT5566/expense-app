"""Synthetic end-to-end graph coverage of trusted clarification choices."""

from copy import deepcopy

import pytest
from conftest import CONTEXT, RAW, REQUEST
from fakes_v3 import IMAGE_REQUEST, make_setup, raw_draft

from semantic_entry.clarification import clarification_result, make_question
from semantic_entry.contracts import parse_response_v3
from semantic_entry.graph import invoke
from semantic_entry.graph_v3 import invoke_v3


def reply(result, option=0):
    chosen = result["options"][option]
    return {
        "question": result["question"],
        "answer": chosen["label"],
        "questionId": result["questionId"],
        "optionId": chosen["id"],
    }


def unequal():
    return {
        **RAW,
        "amount": 341,
        "payerId": "乙",
        "scope": "household",
        "hasSharedIntent": True,
        "splitMemberIds": ["我", "乙"],
        "splitDifference": 28,
        "unsupportedReason": "unequal_split",
    }


async def test_repro_split_candidates_then_trusted_write(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = unequal()
    first = await invoke(REQUEST, "synthetic", deps)
    assert first["status"] == "needs_input" and first["purpose"] == "split"
    assert [o["id"] for o in first["options"]] == [
        "equal",
        "split:185:156",
        "split:184:157",
        "custom",
    ]
    assert not first["allowFreeText"]
    assert all(f"{i + 1}." in first["question"] for i in range(4))
    assert parse_response_v3(first) == first
    adapter.persist_expense.assert_not_awaited()
    result = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert adapter.persist_expense.call_args.args[2]["shares_json"] == {
        "a@example.test": 185,
        "b@example.test": 156,
    }


async def test_custom_choice_returns_editable_draft_without_write(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = unequal()
    first = await invoke(REQUEST, "synthetic", deps)
    result = await invoke({**REQUEST, "history": [reply(first, 3)]}, "synthetic", deps)
    assert result["status"] == "drafts" and len(result["drafts"]) == 1
    assert sum(result["drafts"][0]["shares"].values()) == 341
    assert parse_response_v3(result) == result
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize("tamper", ["id", "questionId", "question", "answer"])
async def test_forged_or_stale_option_never_writes(setup, tamper):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "payerId": "unknown"}
    first = await invoke(REQUEST, "synthetic", deps)
    turn = reply(first)
    if tamper == "id":
        turn["optionId"] = "forged@example.test"
    elif tamper == "questionId":
        turn["questionId"] = "00000000-0000-4000-8000-000000000000"
    elif tamper == "question":
        turn["question"] = "different"
    elif tamper == "answer":
        turn["answer"] = "different"
    result = await invoke({**REQUEST, "history": [turn]}, "synthetic", deps)
    assert result["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()


async def test_selected_payer_overrides_model_unknown_id(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "payerId": "unmatched"}
    first = await invoke(REQUEST, "synthetic", deps)
    assert first["purpose"] == "payer" and len(first["options"]) == 2
    result = await invoke({**REQUEST, "history": [reply(first)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert (
        adapter.persist_expense.call_args.args[2]["payer_email"]
        == CONTEXT["currentUserEmail"]
    )


async def test_identity_question_precedes_split_interpretation(setup):
    deps, adapter = setup
    raw = unequal()
    raw["payerId"] = "unknown"
    deps.extract_entry.return_value["raw"] = raw
    first = await invoke(REQUEST, "synthetic", deps)
    assert first["purpose"] == "payer"
    deps.extract_entry.return_value["raw"]["scope"] = "household"
    second = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert second["purpose"] == "split"
    adapter.persist_expense.assert_not_awaited()


async def test_single_category_auto_resolves_without_question(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "categoryId": None}
    assert (await invoke(REQUEST, "synthetic", deps))["status"] == "created"
    assert (
        adapter.persist_expense.call_args.args[2]["category_id"]
        == CONTEXT["categories"][0]["id"]
    )


def test_option_cap_labels_and_free_text_rules():
    context = deepcopy(CONTEXT)
    context["members"] *= 4
    context["members"][0]["name"] = "名字" * 80
    question = make_question("members", REQUEST, context)
    assert len(question["options"]) == 4
    assert all(1 <= len(o["label"]) <= 80 for o in question["options"])
    assert len(question["question"]) <= 300 and not question["allowFreeText"]
    free = make_question("amount", REQUEST, context)
    assert free["options"] == [] and free["allowFreeText"]


def test_three_questions_then_rejected():
    validation = {"issues": [{"field": "amount", "code": "missing"}]}
    history = []
    for _ in range(3):
        result = clarification_result(
            validation, {**REQUEST, "history": history}, CONTEXT
        )
        assert result["status"] == "needs_input"
        history.append({"question": result["question"], "answer": "不知道"})
    assert (
        clarification_result(validation, {**REQUEST, "history": history}, CONTEXT)[
            "status"
        ]
        == "rejected"
    )


async def test_image_common_payer_options_and_history():
    deps, adapter, _ = make_setup()
    r = raw_draft()
    r["payerEmail"].update(value="unknown", source="text")
    deps.extract_drafts.return_value["raw"]["drafts"] = [r]
    first = await invoke_v3(IMAGE_REQUEST, "synthetic", deps)
    assert first["status"] == "needs_input" and first["purpose"] == "payer"
    assert parse_response_v3(first) == first
    request = {
        **IMAGE_REQUEST,
        "conversationStartedAt": "2026-11-26T03:00:00Z",
        "history": [reply(first)],
    }
    result = await invoke_v3(request, "synthetic", deps)
    assert result["status"] == "created"
    assert deps.extract_drafts.call_args.args[0]["history"] == request["history"]
    assert adapter.persist_expense.call_args.args[2]["payer_email"] == "a@example.test"


async def test_image_split_options_and_custom_draft():
    deps, adapter, _ = make_setup()
    r = raw_draft()
    r["amount"]["value"] = 341
    r["scope"].update(value="household", source="text", state="recognized")
    r["splitMemberEmails"].update(value=["我", "乙"], source="text", state="recognized")
    r["splitDifference"] = 28
    deps.extract_drafts.return_value["raw"]["drafts"] = [r]
    first = await invoke_v3(IMAGE_REQUEST, "synthetic", deps)
    assert first["status"] == "needs_input" and first["purpose"] == "split"
    result = await invoke_v3(
        {
            **IMAGE_REQUEST,
            "conversationStartedAt": "2026-11-26T03:00:00Z",
            "history": [reply(first, 3)],
        },
        "synthetic",
        deps,
    )
    assert result["status"] == "drafts" and result["drafts"][0]["shares"]
    adapter.persist_expense.assert_not_awaited()


async def test_image_per_item_missing_amount_stays_in_draft():
    deps, adapter, _ = make_setup()
    deps.extract_drafts.return_value["raw"]["drafts"][0]["amount"].update(
        value=None, state="unrecognized"
    )
    assert (await invoke_v3(IMAGE_REQUEST, "synthetic", deps))["status"] == "drafts"
    adapter.persist_expense.assert_not_awaited()


async def test_split_answer_survives_model_incorporating_answer(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = unequal()
    first = await invoke(REQUEST, "synthetic", deps)
    deps.extract_entry.return_value["raw"].update(
        splitDifference=None,
        splitMemberIds=None,
        shares={"a@example.test": 185, "b@example.test": 156},
    )
    result = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert adapter.persist_expense.call_args.args[2]["shares_json"] == {
        "a@example.test": 185,
        "b@example.test": 156,
    }


async def test_image_split_answer_applies_to_different_item_totals():
    deps, adapter, _ = make_setup()
    items = []
    for amount in (341, 501):
        r = raw_draft()
        r["draftId"] = None
        r["amount"]["value"] = amount
        r["scope"].update(value="household", source="text", state="recognized")
        r["splitMemberEmails"].update(
            value=["我", "乙"], source="text", state="recognized"
        )
        r["splitDifference"] = 28
        items.append(r)
    deps.extract_drafts.return_value["raw"]["drafts"] = items
    first = await invoke_v3(IMAGE_REQUEST, "synthetic", deps)
    assert first["purpose"] == "split"
    for choice in (0, 1, 3):
        result = await invoke_v3(
            {
                **IMAGE_REQUEST,
                "conversationStartedAt": "2026-11-26T03:00:00Z",
                "history": [reply(first, choice)],
            },
            "synthetic",
            deps,
        )
        assert result["status"] == "drafts"
        assert [sum(d["shares"].values()) for d in result["drafts"]] == [341, 501]
    adapter.persist_expense.assert_not_awaited()


async def test_selected_member_appends_to_known_caller_and_repairs_one_unknown_at_a_time(
    setup,
):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {
        **unequal(),
        "splitMemberIds": ["a"],
        "splitDifference": None,
        "unsupportedReason": None,
    }
    first = await invoke(REQUEST, "synthetic", deps)
    assert first["purpose"] == "member"
    result = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert set(adapter.persist_expense.call_args.args[2]["shares_json"]) == {
        "a@example.test",
        "b@example.test",
    }
    adapter.persist_expense.reset_mock()
    deps.extract_entry.return_value["raw"]["splitMemberIds"] = ["unknown1", "unknown2"]
    first = await invoke(REQUEST, "synthetic", deps)
    second = await invoke({**REQUEST, "history": [reply(first)]}, "synthetic", deps)
    assert second["status"] == "needs_input"
    final = await invoke(
        {**REQUEST, "history": [reply(first), reply(second, 1)]}, "synthetic", deps
    )
    assert final["status"] == "created"


async def test_categories_beyond_four_remain_reachable_and_page_ids_cannot_write(setup):
    deps, adapter = setup
    adapter.load_context.return_value["categories"] = [
        {"id": f"00000000-0000-4000-8000-{i:012}", "name": f"分類{i}"} for i in range(8)
    ]
    deps.extract_entry.return_value["raw"]["categoryId"] = None
    first = await invoke(REQUEST, "synthetic", deps)
    assert len(first["options"]) == 4 and first["options"][-1]["label"] == "其他分類"
    second = await invoke({**REQUEST, "history": [reply(first, 3)]}, "synthetic", deps)
    assert second["status"] == "needs_input"
    adapter.persist_expense.assert_not_awaited()
    third = await invoke(
        {**REQUEST, "history": [reply(first, 3), reply(second, 3)]}, "synthetic", deps
    )
    assert third["status"] == "needs_input"
    result = await invoke(
        {**REQUEST, "history": [reply(first, 3), reply(second, 3), reply(third, 1)]},
        "synthetic",
        deps,
    )
    assert result["status"] == "created"
    assert (
        adapter.persist_expense.call_args.args[2]["category_id"]
        == adapter.load_context.return_value["categories"][7]["id"]
    )


@pytest.mark.parametrize("field", ["shares", "splitRatio"])
async def test_unknown_share_identifier_requires_member_choice_before_split(
    setup, field
):
    deps, adapter = setup
    raw = {
        **unequal(),
        "splitDifference": None,
        "unsupportedReason": None,
        field: {"a": 185 if field == "shares" else 185, "unknown": 156},
    }
    deps.extract_entry.return_value["raw"] = raw
    first = await invoke(REQUEST, "synthetic", deps)
    assert first["purpose"] == "member"
    result = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert adapter.persist_expense.call_args.args[2]["shares_json"] == {
        "a@example.test": 185,
        "b@example.test": 156,
    }


async def test_image_forged_option_and_three_unresolved_answers_never_write():
    deps, adapter, _ = make_setup()
    r = raw_draft()
    r["payerEmail"].update(value="unmatched", state="recognized", source="text")
    deps.extract_drafts.return_value["raw"]["drafts"] = [r]
    first = await invoke_v3(IMAGE_REQUEST, "synthetic", deps)
    turn = {**reply(first), "optionId": "outside-context"}
    assert (
        await invoke_v3(
            {
                **IMAGE_REQUEST,
                "conversationStartedAt": "2026-11-26T03:00:00Z",
                "history": [turn],
            },
            "synthetic",
            deps,
        )
    )["status"] == "rejected"
    history = [{"question": "請確認", "answer": "不知道"}] * 3
    assert (
        await invoke_v3(
            {
                **IMAGE_REQUEST,
                "conversationStartedAt": "2026-11-26T03:00:00Z",
                "history": history,
            },
            "synthetic",
            deps,
        )
    )["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()


async def test_fractional_difference_replay_uses_lossless_question_numbers(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**unequal(), "splitDifference": 28.999999}
    first = await invoke(REQUEST, "synthetic", deps)
    assert "28.999999" in first["question"]
    deps.extract_entry.return_value["raw"].update(
        splitDifference=None,
        splitMemberIds=None,
        shares={"a@example.test": 185, "b@example.test": 156},
    )
    assert (await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps))[
        "status"
    ] == "created"
    assert (
        adapter.persist_expense.call_args.args[2]["shares_json"]["a@example.test"]
        == 185
    )


async def test_single_member_never_silently_replaces_explicit_unknown_payer(setup):
    deps, adapter = setup
    adapter.load_context.return_value["members"] = [CONTEXT["members"][0]]
    deps.extract_entry.return_value["raw"]["payerId"] = "unknown-person"
    assert (await invoke(REQUEST, "synthetic", deps))["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()
    deps.extract_entry.return_value["raw"]["payerId"] = None
    assert (await invoke(REQUEST, "synthetic", deps))["status"] == "created"


async def test_receipt_unspecified_custom_amounts_ask_split_candidates():
    deps, adapter, _ = make_setup()
    r = raw_draft()
    r["scope"].update(value="household", source="text", state="recognized")
    r["splitMemberEmails"].update(value=["我", "乙"], source="text", state="recognized")
    r["shares"] = {}
    deps.extract_drafts.return_value["raw"]["drafts"] = [r]
    result = await invoke_v3(IMAGE_REQUEST, "synthetic", deps)
    assert result["status"] == "needs_input" and result["purpose"] == "split"
    assert [o["id"] for o in result["options"]] == ["equal", "custom"]
    adapter.persist_expense.assert_not_awaited()


def test_long_member_names_do_not_hide_split_amounts():
    context = deepcopy(CONTEXT)
    for member in context["members"]:
        member["name"] = "很長的名稱" * 30
    result = make_question(
        "shares",
        REQUEST,
        context,
        split={
            "amount": 341,
            "emails": [m["email"] for m in context["members"]],
            "difference": 28,
        },
    )
    assert all(len(option["label"]) <= 80 for option in result["options"])
    assert (
        "185 元" in result["options"][1]["label"]
        and "156 元" in result["options"][1]["label"]
    )
    assert "185 元" in result["question"] and "156 元" in result["question"]


@pytest.mark.parametrize(
    "names",
    [("同名", "同名"), ("A" * 80 + "甲", "a" * 80 + "乙"), ("é  名", "e\u0301 名")],
)
async def test_colliding_member_labels_are_distinct_and_bound_to_correct_write(
    setup, names
):
    deps, adapter = setup
    for member, name in zip(
        adapter.load_context.return_value["members"], names, strict=True
    ):
        member["name"] = name
    deps.extract_entry.return_value["raw"] = {
        **RAW,
        "payerId": "unknown",
        "scope": "household",
        "hasSharedIntent": True,
        "splitMemberIds": ["a", "b"],
    }
    first = await invoke(REQUEST, "synthetic", deps)
    labels = [option["label"] for option in first["options"]]
    assert len({label.casefold() for label in labels}) == 2
    assert all(1 <= len(label) <= 80 and label in first["question"] for label in labels)
    assert len(first["question"]) <= 300
    result = await invoke({**REQUEST, "history": [reply(first, 1)]}, "synthetic", deps)
    assert result["status"] == "created"
    assert adapter.persist_expense.call_args.args[2]["payer_email"] == "b@example.test"


@pytest.mark.parametrize("image", [False, True])
@pytest.mark.parametrize("tamper", ["removed_member", "another_user"])
async def test_selected_member_must_remain_in_callers_context(setup, image, tamper):
    deps, adapter = setup
    request, run = REQUEST, invoke
    if image:
        deps, adapter, _ = make_setup()
        request, run = (
            {**IMAGE_REQUEST, "conversationStartedAt": "2026-11-26T03:00:00Z"},
            invoke_v3,
        )
        draft = raw_draft()
        draft["scope"].update(value="household", state="recognized", source="text")
        draft["payerEmail"].update(value="unknown", state="recognized", source="text")
        draft["splitMemberEmails"].update(
            value=["a", "b"], state="recognized", source="text"
        )
        deps.extract_drafts.return_value["raw"]["drafts"] = [draft]
    else:
        deps.extract_entry.return_value["raw"] = {
            **RAW,
            "payerId": "unknown",
            "scope": "household",
            "hasSharedIntent": True,
            "splitMemberIds": ["a", "b"],
        }
    first = await run(request, "synthetic", deps)
    turn = reply(first, 1)
    assert turn["optionId"] == "b"
    if tamper == "removed_member":
        adapter.load_context.return_value["members"] = [
            deepcopy(CONTEXT["members"][0]),
            {"id": "c", "email": "c@example.test", "name": "丙"},
        ]
    else:
        turn["optionId"] = "other-user@example.test"
    # The latest extraction is otherwise valid, including a still-authorized caller.
    members = [m["id"] for m in adapter.load_context.return_value["members"]]
    if image:
        draft["payerEmail"]["value"] = "a"
        draft["splitMemberEmails"]["value"] = members
    else:
        deps.extract_entry.return_value["raw"].update(
            payerId="a", splitMemberIds=members
        )
    result = await run({**request, "history": [turn]}, "synthetic", deps)
    assert result["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()
    if image:
        adapter.persist_expenses.assert_not_awaited()
    # Control: without the stale/foreign option, the same valid extraction writes.
    assert (await run(request, "synthetic", deps))["status"] == "created"


@pytest.mark.parametrize("image", [False, True])
@pytest.mark.parametrize("answer", ["2", "label", "plain free text"])
async def test_base_history_exact_number_or_label_resolves_trusted_option(
    setup, image, answer
):
    deps, adapter = setup
    request, run = REQUEST, invoke
    if image:
        deps, adapter, _ = make_setup()
        request, run = (
            {**IMAGE_REQUEST, "conversationStartedAt": "2026-11-26T03:00:00Z"},
            invoke_v3,
        )
        draft = raw_draft()
        draft["scope"].update(value="household", state="recognized", source="text")
        draft["payerEmail"].update(value="unknown", state="recognized", source="text")
        draft["splitMemberEmails"].update(
            value=["a", "b"], state="recognized", source="text"
        )
        deps.extract_drafts.return_value["raw"]["drafts"] = [draft]
    else:
        deps.extract_entry.return_value["raw"] = {
            **RAW,
            "payerId": "unknown",
            "scope": "household",
            "hasSharedIntent": True,
            "splitMemberIds": ["a", "b"],
        }
    first = await run(request, "synthetic", deps)
    turn = {
        "question": first["question"],
        "answer": first["options"][1]["label"] if answer == "label" else answer,
    }
    result = await run({**request, "history": [turn]}, "synthetic", deps)
    if answer == "plain free text":
        assert result["status"] == "needs_input"
        adapter.persist_expense.assert_not_awaited()
    else:
        assert result["status"] == "created"
        assert (
            adapter.persist_expense.call_args.args[2]["payer_email"] == "b@example.test"
        )


async def test_numbered_category_fallback_can_advance_pages(setup):
    deps, adapter = setup
    adapter.load_context.return_value["categories"] = [
        {"id": f"00000000-0000-4000-8000-{i:012}", "name": f"分類{i}"} for i in range(6)
    ]
    deps.extract_entry.return_value["raw"]["categoryId"] = None
    first = await invoke(REQUEST, "synthetic", deps)
    history = [{"question": first["question"], "answer": "4"}]
    second = await invoke({**REQUEST, "history": history}, "synthetic", deps)
    assert second["status"] == "needs_input"
    history.append({"question": second["question"], "answer": "2"})
    result = await invoke({**REQUEST, "history": history}, "synthetic", deps)
    assert result["status"] == "created"
    assert (
        adapter.persist_expense.call_args.args[2]["category_id"]
        == adapter.load_context.return_value["categories"][4]["id"]
    )
