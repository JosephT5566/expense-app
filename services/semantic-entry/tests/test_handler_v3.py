import asyncio
import json

import httpx
import pytest
from conftest import REQUEST, REQUEST_ID, ROW
from fakes_v3 import IMAGE_REQUEST, client_draft, make_setup

from semantic_entry.contracts import (
    parse_response_v3,
    parse_status_response_v3,
    parse_stream_event_v3,
)
from semantic_entry.errors import SemanticError
from semantic_entry.handler import accepts_v3
from semantic_entry.server import create_app


async def response(
    deps,
    body=None,
    *,
    accept="application/json; semantic-version=3",
    method="POST",
    path="/semantic-entry",
    content=None,
):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://localhost"
    ) as c:
        return await c.request(
            method,
            path,
            headers={"Authorization": "Bearer synthetic", "Accept": accept},
            **({"content": content} if content is not None else {"json": body}),
        )


def frames(r):
    events = []
    for frame in r.text.strip().split("\n\n"):
        event, payload = frame.split("\n")
        name = event.removeprefix("event: ")
        data = json.loads(payload.removeprefix("data: "))
        parse_stream_event_v3(name, data)
        events.append((name, data))
    assert events[-1][0] in ("result", "error")
    assert all(e[0] not in ("result", "error") for e in events[:-1])
    return events


@pytest.mark.parametrize(
    "key,value",
    [("action", "analyze"), ("images", ["uploads/a/a.jpg"]), ("drafts", [])],
)
async def test_v2_rejects_v3_keys(key, value):
    deps, _, _ = make_setup()
    r = await response(deps, {**REQUEST, key: value}, accept="application/json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "version,size,status",
    [(2, 8192, 200), (2, 8193, 400), (3, 65536, 200), (3, 65537, 400)],
)
async def test_exact_body_limits(version, size, status):
    deps, _, _ = make_setup()
    body = json.dumps(
        {**REQUEST, **({"action": "analyze"} if version == 3 else {})}
    ).encode()
    r = await response(
        deps,
        content=body + b" " * (size - len(body)),
        accept=f"application/json; semantic-version={version}",
    )
    assert r.status_code == status
    if status == 400:
        assert r.json()["error"]["code"] == "body_too_large"
    elif version == 3:
        parse_response_v3(r.json())


@pytest.mark.parametrize(
    "accept,expected",
    [
        ("application/json; semantic-version=3", True),
        ("application/json; semantic-version=3; q=0.0", False),
        ("application/json; semantic-version=3; q=0.1", True),
        ("application/json; semantic-version=2", False),
        ("text/plain, application/json; semantic-version=3", True),
    ],
)
def test_accept_negotiation(accept, expected):
    assert accepts_v3(accept, "application/json") is expected


async def test_text_v3_sse_analysis_then_persisting_result():
    deps, adapter, _ = make_setup()

    async def stream(text, context, analysis):
        await analysis("已辨識午餐。")
        return await deps.extract_entry(text, context)

    deps.stream_entry = stream
    r = await response(
        deps,
        {**REQUEST, "action": "analyze"},
        accept="text/event-stream; semantic-version=3",
    )
    events = frames(r)
    assert [e[0] for e in events] == ["analysis_delta", "persisting", "result"]
    assert len(events[-1][1]["expenses"]) == 1
    adapter.consume_quota.assert_awaited_once()


@pytest.mark.parametrize("action", ["analyze", "revise", "commit"])
async def test_v3_sse_shapes_and_quota(action):
    deps, adapter, _ = make_setup()
    body = (
        IMAGE_REQUEST
        if action == "analyze"
        else {
            "requestId": REQUEST_ID,
            "action": action,
            "drafts": [client_draft()],
            **({"text": "確認"} if action == "revise" else {}),
        }
    )
    r = await response(deps, body, accept="text/event-stream; semantic-version=3")
    events = frames(r)
    assert [e[0] for e in events] == (
        ["result"] if action == "revise" else ["persisting", "result"]
    )
    assert adapter.consume_quota.await_count == (0 if action == "commit" else 1)


async def test_incomplete_image_sse_has_no_persisting():
    deps, adapter, _ = make_setup()
    deps.extract_drafts.return_value["raw"]["drafts"][0]["amount"]["confidence"] = 0.69
    events = frames(
        await response(
            deps, IMAGE_REQUEST, accept="text/event-stream; semantic-version=3"
        )
    )
    assert [e[0] for e in events] == ["result"]
    assert events[0][1]["status"] == "drafts"
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize(
    "uncertain,code", [(False, "rpc_rejected"), (True, "persist_uncertain")]
)
async def test_batch_sse_rejection_and_timeout(uncertain, code):
    deps, adapter, _ = make_setup()
    adapter.persist_expenses.side_effect = (
        TimeoutError()
        if uncertain
        else SemanticError(422, "rpc_rejected", diagnostics={"rowIndex": 1})
    )
    events = frames(
        await response(
            deps,
            {"requestId": REQUEST_ID, "action": "commit", "drafts": [client_draft()]},
            accept="text/event-stream; semantic-version=3",
        )
    )
    assert [e[0] for e in events] == ["persisting", "error"]
    assert events[-1][1] == {"error": {"code": code, "uncertain": uncertain}}
    if not uncertain:
        assert any(c.args[0].get("rowIndex") == 1 for c in deps.log.call_args_list)


@pytest.mark.parametrize(
    "field,value,status",
    [
        ("amount", 99.01, 400),
        ("date", "2026-03-02", 422),
        ("currency", "USD", 422),
        ("categoryId", "tampered", 422),
        ("payerEmail", "outsider@example.test", 422),
    ],
)
async def test_commit_wire_and_strict_rejections(field, value, status):
    deps, adapter, _ = make_setup()
    d = client_draft()
    d[field]["value"] = value
    r = await response(
        deps, {"requestId": REQUEST_ID, "action": "commit", "drafts": [d]}
    )
    assert r.status_code == status
    if status == 422:
        parse_response_v3(r.json())
        assert r.json()["draftIssues"]
    adapter.persist_expenses.assert_not_awaited()


@pytest.mark.parametrize(
    "saved",
    [
        None,
        {"expenses": [ROW], "replayed": True},
        {"expenses": [ROW, ROW], "replayed": True},
    ],
)
async def test_get_v3_single_batch_and_not_found(saved):
    deps, adapter, _ = make_setup()
    adapter.lookup_completed_v3.return_value = saved
    r = await response(deps, method="GET", path=f"/semantic-entry/{REQUEST_ID}")
    assert r.status_code == 200
    parse_status_response_v3(r.json())
    assert r.json()["status"] == ("completed" if saved else "not_found")


async def test_get_v2_batch_is_unsupported():
    deps, adapter, _ = make_setup()
    adapter.lookup_completed.side_effect = SemanticError(409, "unsupported_version")
    r = await response(
        deps,
        method="GET",
        path=f"/semantic-entry/{REQUEST_ID}",
        accept="application/json",
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "unsupported_version"


async def test_only_image_analyze_gets_image_deadline():
    deps, _, _ = make_setup()
    deps.http_deadline = 0.02
    deps.image_deadline = 1
    original = deps.extract_drafts

    async def slow(*args):
        await asyncio.sleep(0.05)
        return await original(*args)

    deps.extract_drafts = slow
    r = await response(deps, IMAGE_REQUEST)
    assert r.status_code == 200
    parse_response_v3(r.json())
    r = await response(
        deps,
        {
            "requestId": REQUEST_ID,
            "action": "revise",
            "text": "確認",
            "drafts": [client_draft()],
        },
    )
    assert r.status_code == 504


async def test_image_deadline_must_be_below_cloud_run_limit():
    deps, _, _ = make_setup()
    deps.image_deadline = 90
    r = await response(deps, IMAGE_REQUEST)
    assert r.status_code == 502 and r.json()["error"]["code"] == "image_configuration"


async def test_v3_q_zero_falls_back_to_v2():
    deps, _, _ = make_setup()
    r = await response(
        deps,
        {**REQUEST, "action": "analyze"},
        accept="application/json; semantic-version=3; q=0",
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"


async def test_v3_requires_action_even_for_legacy_shaped_body():
    deps, adapter, _ = make_setup()
    r = await response(deps, REQUEST, accept="text/event-stream; semantic-version=3")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_request"
    adapter.authenticate.assert_not_awaited()
