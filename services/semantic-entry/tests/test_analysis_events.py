import asyncio

import pytest
from conftest import REQUEST, ROW
from test_graph_handler import client_response

from semantic_entry.graph import invoke


@pytest.mark.parametrize(
    "accept,analysis",
    [
        ("text/event-stream", False),
        ('text/event-stream; semantic-version="2"', True),
        ("application/json, text/event-stream; semantic-version=2", True),
        ("text/event-stream; semantic-version=3", False),
    ],
)
async def test_versioned_analysis_events_preserve_decisions(setup, accept, analysis):
    deps, adapter = setup

    async def stream(text, context, on_analysis):
        await on_analysis("資料完整")
        return {
            **deps.extract_entry.return_value,
            "raw": {**deps.extract_entry.return_value["raw"], "amount": None},
        }

    deps.stream_entry = stream
    # v1 uses the original extractor, but receives no new public event.
    deps.extract_entry.return_value["raw"]["amount"] = None
    response = await client_response(
        deps, headers={"Authorization": "Bearer t", "Accept": accept}, json=REQUEST
    )
    assert ("event: analysis_delta" in response.text) is analysis
    assert '"status":"needs_input"' in response.text
    assert "總金額" in response.text
    adapter.persist_expense.assert_not_awaited()


async def test_full_queue_disconnect_before_rpc_does_not_retain_operation(setup):
    from semantic_entry.handler import _operations, stream_operation

    deps, adapter = setup
    returned = asyncio.Event()

    async def stream(text, context, callback):
        for _ in range(65):
            await callback("字")
        returned.set()
        return deps.extract_entry.return_value

    deps.stream_entry = stream
    baseline = set(_operations)
    response = stream_operation(REQUEST, "t", deps, 0.15, include_analysis=True)
    assert b"analysis_delta" in await anext(response)
    await asyncio.wait_for(returned.wait(), 1)
    await asyncio.sleep(0.02)
    await response.aclose()
    await asyncio.sleep(0.2)
    retained = set(_operations) - baseline
    try:
        assert not retained
        adapter.persist_expense.assert_not_awaited()
    finally:
        for task in retained:
            task.cancel()
        await asyncio.gather(*retained, return_exceptions=True)


async def test_full_queue_timeout_delivers_terminal_error(setup):
    from semantic_entry.handler import stream_operation

    deps, adapter = setup
    filled = asyncio.Event()

    async def stream(text, context, callback):
        for i in range(100):
            if i == 65:
                filled.set()
            await callback("字")
        return deps.extract_entry.return_value

    deps.stream_entry = stream
    response = stream_operation(REQUEST, "t", deps, 0.5, include_analysis=True)
    assert b"analysis_delta" in await anext(response)
    await asyncio.wait_for(filled.wait(), 1)
    await asyncio.sleep(0.6)
    frame = await asyncio.wait_for(anext(response), 0.1)
    assert b"event: error" in frame
    await response.aclose()
    adapter.persist_expense.assert_not_awaited()


async def test_analysis_before_persist_and_result(setup):
    deps, adapter = setup
    events = []

    async def stream(text, context, on_analysis):
        await on_analysis("午餐")
        return deps.extract_entry.return_value

    async def analysis(text):
        events.append(text)

    async def writing(payload):
        events.append("persisting")

    deps.stream_entry = stream
    result = await invoke(
        REQUEST, "t", deps, on_persisting=writing, on_analysis=analysis
    )
    assert events == ["午餐", "persisting"]
    assert result["expense"] == ROW
    adapter.lookup_completed.return_value = {"expense": ROW, "replayed": True}
    events.clear()
    result = await invoke(REQUEST, "t", deps, on_analysis=analysis)
    assert result["replayed"] and not events


async def test_analysis_queue_applies_backpressure_and_cancels(setup):
    from semantic_entry.handler import stream_operation

    deps, adapter = setup
    produced = []
    blocked = asyncio.Event()
    cancelled = asyncio.Event()

    async def stream(text, context, on_analysis):
        try:
            for _ in range(100):
                produced.append(1)
                if len(produced) == 66:
                    blocked.set()
                await on_analysis("字")
        finally:
            cancelled.set()
        return deps.extract_entry.return_value

    deps.stream_entry = stream
    response = stream_operation(REQUEST, "t", deps, 1, include_analysis=True)
    first = await anext(response)
    assert b"analysis_delta" in first
    await asyncio.wait_for(blocked.wait(), 1)
    assert len(produced) == 66
    await response.aclose()
    await asyncio.wait_for(cancelled.wait(), 1)
    adapter.persist_expense.assert_not_awaited()
