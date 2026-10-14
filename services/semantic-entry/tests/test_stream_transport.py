"""Actual loopback HTTP disconnection tests, with synthetic dependencies only."""

import asyncio
import json
import socket
from contextlib import asynccontextmanager

import httpx
import uvicorn
from conftest import REQUEST, ROW

from semantic_entry.server import create_app


@asynccontextmanager
async def serve(deps):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(deps), lifespan="off", log_level="critical", access_log=False
        )
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 5)
        sock.close()


async def read_frame(lines):
    event = ""
    data = ""
    async for line in lines:
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
        elif not line and data:
            return event, json.loads(data)
    raise AssertionError("Missing frame")


HEADERS = {
    "Authorization": "Bearer synthetic",
    "Accept": "text/event-stream; semantic-version=2",
}


async def test_http_analysis_arrives_before_terminal_result(setup):
    deps, _ = setup
    release = asyncio.Event()

    async def stream(text, context, callback):
        await callback("辨識午餐")
        await release.wait()
        return deps.extract_entry.return_value

    deps.stream_entry = stream
    async with serve(deps) as url, httpx.AsyncClient(base_url=url) as client:
        async with client.stream(
            "POST", "/semantic-entry", headers=HEADERS, json=REQUEST
        ) as response:
            lines = response.aiter_lines()
            name, data = await asyncio.wait_for(read_frame(lines), 1)
            assert name == "analysis_delta" and data["text"] == "辨識午餐"
            release.set()
            assert (await read_frame(lines))[0] == "persisting"
            name, data = await read_frame(lines)
            assert name == "result" and data["expense"] == ROW


async def test_http_disconnect_before_persistence_cancels_extraction(setup):
    deps, adapter = setup
    cancelled = asyncio.Event()

    async def stream(text, context, callback):
        try:
            await callback("辨識中")
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        return deps.extract_entry.return_value

    deps.stream_entry = stream
    async with serve(deps) as url, httpx.AsyncClient(base_url=url) as client:
        async with client.stream(
            "POST", "/semantic-entry", headers=HEADERS, json=REQUEST
        ) as response:
            assert (await read_frame(response.aiter_lines()))[0] == "analysis_delta"
        await asyncio.wait_for(cancelled.wait(), 1)
    adapter.persist_expense.assert_not_awaited()


async def test_http_disconnect_after_persistence_preserves_status_recovery(setup):
    deps, adapter = setup
    release = asyncio.Event()
    finished = asyncio.Event()

    async def persist(*args):
        await release.wait()
        adapter.lookup_completed.return_value = {"expense": ROW, "replayed": False}
        finished.set()
        return adapter.lookup_completed.return_value

    adapter.persist_expense.side_effect = persist
    async with serve(deps) as url, httpx.AsyncClient(base_url=url) as client:
        async with client.stream(
            "POST", "/semantic-entry", headers=HEADERS, json=REQUEST
        ) as response:
            assert (await read_frame(response.aiter_lines()))[0] == "persisting"
        release.set()
        await asyncio.wait_for(finished.wait(), 1)
        result = await client.get(
            f"/semantic-entry/{REQUEST['requestId']}", headers=HEADERS
        )
        assert (
            result.json()["status"] == "completed" and result.json()["expense"] == ROW
        )
    adapter.persist_expense.assert_awaited_once()
