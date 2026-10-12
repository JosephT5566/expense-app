import asyncio

import pytest
from conftest import CONTEXT, RAW, REQUEST, REQUEST_ID, ROW
from test_graph_handler import client_response

from semantic_entry.contracts import parse_request
from semantic_entry.graph import input_hash, invoke

HISTORY = [{"question": "總金額是多少？", "answer": "851 元"}]


async def test_missing_amount_asks_without_persisting(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "amount": None}
    result = await invoke(REQUEST, "t", deps)
    assert result["status"] == "needs_input"
    assert "金額" in result["question"]
    assert result["issues"] == [{"field": "amount", "code": "missing"}]
    adapter.persist_expense.assert_not_awaited()
    adapter.consume_quota.assert_awaited_once()


async def test_answer_resolves_same_expense_and_changes_payload_hash(setup):
    deps, adapter = setup
    request = {**REQUEST, "history": HISTORY}
    result = await invoke(request, "t", deps)
    assert result["status"] == "created" and result["expense"] == ROW
    assert adapter.persist_expense.call_args.args[0] == REQUEST_ID
    assert adapter.persist_expense.call_args.args[1] == input_hash(request)
    assert input_hash(request) != input_hash(REQUEST)
    assert "851 元" in deps.extract_entry.call_args.args[0]
    assert "總金額" in deps.extract_entry.call_args.args[0]


@pytest.mark.parametrize(
    "patch",
    [
        {"payerId": "__unknown__"},
        {"payerId": "__ambiguous__"},
        {"scope": "household", "hasSharedIntent": True},
        {"date": {"kind": "absolute", "value": "2026-02-30"}},
        {"amount": 0},
        {"note": None},
        {"currency": "USD"},
    ],
)
async def test_repairable_fields_are_questions(setup, patch):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, **patch}
    assert (await invoke(REQUEST, "t", deps))["status"] == "needs_input"
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize("patch", [{"unsupportedReason": "refund"}, {"extra": "x"}])
async def test_unsupported_intent_and_bad_schema_do_not_loop(setup, patch):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, **patch}
    assert (await invoke(REQUEST, "t", deps))["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()


async def test_follow_up_limit_and_configuration_are_terminal(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "amount": None}
    assert (await invoke({**REQUEST, "history": HISTORY * 3}, "t", deps))[
        "status"
    ] == "rejected"
    adapter.load_context.return_value = {**CONTEXT, "otherCategoryId": "absent"}
    assert (await invoke(REQUEST, "t", deps))["status"] == "rejected"
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize(
    "history",
    [
        None,
        {},
        [],
        HISTORY * 4,
        [{"question": "", "answer": "1"}],
        [{"question": "q", "answer": "a", "userId": "a"}],
        [{"question": "q" * 301, "answer": "a"}],
        [{"question": "q", "answer": "🍜" * 501}],
    ],
)
def test_invalid_history(history):
    # Empty history canonicalizes to absent instead of getting a different hash.
    if history == []:
        assert parse_request({**REQUEST, "history": history}) == REQUEST
    else:
        with pytest.raises(ValueError):
            parse_request({**REQUEST, "history": history})


async def test_stream_persisting_before_rpc_and_result_after(setup):
    deps, adapter = setup
    events = []

    async def event(payload):
        events.append(payload)

    async def persist(*args):
        assert events == [{"status": "persisting", "requestId": REQUEST_ID}]
        return {"expense": ROW, "replayed": False}

    adapter.persist_expense.side_effect = persist
    result = await invoke(REQUEST, "t", deps, on_persisting=event)
    assert result["status"] == "created"


async def test_sse_needs_input_has_no_persisting(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "amount": None}
    response = await client_response(
        deps,
        headers={"Authorization": "Bearer t", "Accept": "text/event-stream"},
        json=REQUEST,
    )
    assert response.status_code == 200 and response.headers["content-type"].startswith(
        "text/event-stream"
    )
    assert "event: result" in response.text and '"needs_input"' in response.text
    assert "event: persisting" not in response.text
    adapter.persist_expense.assert_not_awaited()


async def test_sse_creation_order_and_timeout(setup):
    deps, adapter = setup
    response = await client_response(
        deps,
        headers={"Authorization": "Bearer t", "Accept": "text/event-stream"},
        json=REQUEST,
    )
    assert response.text.index("event: persisting") < response.text.index(
        "event: result"
    )

    async def slow(*args):
        await asyncio.sleep(1)

    deps.http_deadline = 0.01
    adapter.persist_expense.side_effect = slow
    response = await client_response(
        deps,
        headers={"Authorization": "Bearer t", "Accept": "text/event-stream"},
        json=REQUEST,
    )
    assert "event: error" in response.text and '"uncertain":true' in response.text


async def test_stream_disconnect_after_persist_does_not_cancel_write(setup):
    from semantic_entry.handler import stream_operation

    deps, adapter = setup
    release = asyncio.Event()
    committed = asyncio.Event()

    async def persist(*args):
        await release.wait()
        committed.set()
        return {"expense": ROW, "replayed": False}

    adapter.persist_expense.side_effect = persist
    stream = stream_operation(REQUEST, "t", deps, 1)
    first = await anext(stream)
    assert b"event: persisting" in first
    await stream.aclose()
    release.set()
    await asyncio.wait_for(committed.wait(), 1)


async def test_stream_disconnect_before_persist_cancels_parsing(setup):
    from semantic_entry.handler import stream_operation

    deps, adapter = setup
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def slow(*args):
        started.set()
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.set()

    deps.extract_entry.side_effect = slow
    stream = stream_operation(REQUEST, "t", deps, 1)
    pending = asyncio.create_task(anext(stream))
    await started.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    await asyncio.wait_for(cancelled.wait(), 1)
    adapter.persist_expense.assert_not_awaited()


async def test_answered_payload_conflict_is_checked_before_model_and_quota(setup):
    from semantic_entry.errors import SemanticError

    deps, adapter = setup
    adapter.lookup_completed.side_effect = SemanticError(409, "request_conflict")
    request = {**REQUEST, "history": HISTORY}
    with pytest.raises(SemanticError, match="request_conflict"):
        await invoke(request, "t", deps)
    adapter.lookup_completed.assert_awaited_once_with(REQUEST_ID, input_hash(request))
    deps.extract_entry.assert_not_awaited()
    adapter.consume_quota.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()
    assert input_hash(request) != input_hash(
        {**request, "history": [{**HISTORY[0], "answer": "100"}]}
    )


async def test_conversation_never_reaches_structured_logs(setup):
    deps, _ = setup
    logs = []
    deps.log = logs.append
    await invoke({**REQUEST, "history": HISTORY}, "private-token", deps)
    assert logs
    for event in logs:
        assert set(event) == {"requestId", "node", "status", "elapsedMs"}
        assert "851 元" not in str(event) and "private-token" not in str(event)
