import asyncio
import hashlib
import json

import httpx
import pytest
from conftest import RAW, REQUEST, REQUEST_ID, ROW

from semantic_entry.errors import SemanticError
from semantic_entry.graph import invoke
from semantic_entry.server import create_app


async def test_creation_and_logging(setup):
    deps, adapter = setup
    result = await invoke(REQUEST, "private-token", deps)
    assert result["status"] == "created" and result["expense"] == ROW
    assert result["metadata"]["inputTokens"] is None
    deps.extract_entry.assert_awaited_once()
    adapter.persist_expense.assert_awaited_once()
    args = adapter.persist_expense.call_args.args
    assert (
        args[0] == REQUEST_ID
        and args[1] == hashlib.sha256("v1\n午餐851".encode()).hexdigest()
    )
    assert not any(
        secret in str(deps.log.call_args_list)
        for secret in ("private-token", "a@example", "午餐")
    )


async def test_replay(setup):
    deps, adapter = setup
    adapter.lookup_completed.return_value = {"expense": ROW, "replayed": True}
    result = await invoke(REQUEST, "t", deps)
    assert result["replayed"] and result["metadata"]["model"] == "replay"
    deps.extract_entry.assert_not_awaited()
    adapter.consume_quota.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize(
    "status,method",
    [(401, "authenticate"), (403, "load_context"), (409, "lookup_completed")],
)
async def test_early_errors(setup, status, method):
    deps, adapter = setup
    getattr(adapter, method).side_effect = SemanticError(status, "synthetic")
    with pytest.raises(SemanticError) as exc:
        await invoke(REQUEST, "t", deps)
    assert exc.value.status == status
    deps.extract_entry.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()


async def test_quota(setup):
    deps, adapter = setup
    adapter.consume_quota.return_value = False
    with pytest.raises(SemanticError) as exc:
        await invoke(REQUEST, "t", deps)
    assert exc.value.status == 429
    deps.extract_entry.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()


async def client_response(deps, method="POST", path="/semantic-entry", **kwargs):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://localhost"
    ) as client:
        return await client.request(method, path, **kwargs)


async def test_rejected_zero_write(setup):
    deps, adapter = setup
    deps.extract_entry.return_value["raw"] = {**RAW, "unsupportedReason": "refund"}
    response = await client_response(
        deps, headers={"Authorization": "Bearer t"}, json=REQUEST
    )
    assert response.status_code == 422
    assert response.json()["issues"] == [{"field": "intent", "code": "unsupported"}]
    adapter.persist_expense.assert_not_awaited()


@pytest.mark.parametrize(
    "body",
    [
        {**REQUEST, "userId": "a"},
        {**REQUEST, "hash": "x"},
        {**REQUEST, "requestId": "bad"},
        {**REQUEST, "text": "x" * 9000},
        [],
    ],
)
async def test_invalid_request(setup, body):
    deps, adapter = setup
    response = await client_response(
        deps, headers={"Authorization": "Bearer t"}, json=body
    )
    assert response.status_code == 400
    deps.extract_entry.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()


async def test_routes_auth_cors_and_get(setup):
    deps, adapter = setup
    assert (await client_response(deps, json=REQUEST)).status_code == 401
    assert (await client_response(deps, "GET", "/healthz")).json() == {"status": "ok"}
    assert (await client_response(deps, "PUT")).status_code == 405
    assert (await client_response(deps, "GET", "/unknown")).status_code == 404
    deps.allowed_origins = ("https://app.test",)
    assert (
        await client_response(deps, "OPTIONS", headers={"Origin": "https://evil.test"})
    ).status_code == 403
    response = await client_response(
        deps, "OPTIONS", headers={"Origin": "https://app.test"}
    )
    assert (
        response.status_code == 204
        and response.headers["Access-Control-Allow-Origin"] == "https://app.test"
    )
    response = await client_response(
        deps,
        "GET",
        f"/semantic-entry/{REQUEST_ID}",
        headers={"Authorization": "Bearer b"},
    )
    assert response.json() == {"status": "not_found", "requestId": REQUEST_ID}
    adapter.lookup_completed.return_value = {"expense": ROW, "replayed": True}
    response = await client_response(
        deps,
        "GET",
        f"/semantic-entry/{REQUEST_ID}",
        headers={"Authorization": "Bearer b"},
    )
    assert response.json()["status"] == "completed"
    adapter.authenticate.side_effect = SemanticError(401, "unauthorized")
    assert (
        await client_response(
            deps,
            "GET",
            f"/semantic-entry/{REQUEST_ID}",
            headers={"Authorization": "Bearer b"},
        )
    ).status_code == 401
    deps.extract_entry.assert_not_awaited()
    adapter.consume_quota.assert_not_awaited()


async def test_persist_transport_uncertainty(setup):
    deps, adapter = setup
    adapter.persist_expense.side_effect = RuntimeError("lost response")
    response = await client_response(
        deps, headers={"Authorization": "Bearer t"}, json=REQUEST
    )
    assert response.status_code == 504 and response.json()["error"] == {
        "code": "persist_uncertain",
        "uncertain": True,
    }


async def test_http_deadline_cancels_before_late_write(setup):
    deps, adapter = setup
    deps.http_deadline = 0.01

    async def slow(*args):
        await asyncio.sleep(1)
        return {"raw": RAW}

    deps.extract_entry.side_effect = slow
    response = await client_response(
        deps, headers={"Authorization": "Bearer t"}, json=REQUEST
    )
    assert response.status_code == 504 and response.json()["error"]["uncertain"] is True
    adapter.persist_expense.assert_not_awaited()


async def test_deadline_includes_slow_body(setup):
    deps, adapter = setup
    deps.http_deadline = 0.01

    async def body():
        yield b"{"
        await asyncio.sleep(1)
        yield json.dumps(REQUEST).encode()

    response = await client_response(
        deps, headers={"Authorization": "Bearer t"}, content=body()
    )
    assert response.status_code == 504
    adapter.authenticate.assert_not_awaited()
