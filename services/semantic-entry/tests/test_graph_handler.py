import asyncio
import hashlib
import json

import httpx
import pytest
from conftest import RAW, REQUEST, REQUEST_ID, ROW
from fastapi import FastAPI

from semantic_entry import server
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


def test_fastapi_application_without_public_docs(setup):
    deps, _ = setup
    app = create_app(deps)
    assert isinstance(app, FastAPI)
    assert app.openapi_url is None
    assert app.docs_url is None
    assert app.redoc_url is None


async def test_lifespan_initializes_dependencies_and_closes_http_client(
    setup, monkeypatch
):
    deps, _ = setup
    clients = []

    def dependencies(client):
        clients.append(client)
        return deps

    monkeypatch.setattr(server, "environment_dependencies", dependencies)
    app = create_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            response = await client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert not clients[0].is_closed
    assert clients[0].is_closed


@pytest.mark.parametrize(
    "method,path,status,code",
    [
        ("GET", "/semantic-entry", 405, "method_not_allowed"),
        ("POST", f"/semantic-entry/{REQUEST_ID}", 405, "method_not_allowed"),
        ("GET", "/semantic-entry/not-a-uuid", 400, "invalid_request"),
        ("POST", "/semantic-entry/", 404, "not_found"),
        ("GET", f"/semantic-entry/{REQUEST_ID}/", 404, "not_found"),
        ("GET", "/health/", 404, "not_found"),
        ("GET", "/docs", 404, "not_found"),
        ("GET", "/redoc", 404, "not_found"),
        ("GET", "/openapi.json", 404, "not_found"),
    ],
)
async def test_routing_preserves_errors_and_cors(setup, method, path, status, code):
    deps, adapter = setup
    deps.allowed_origins = ("https://app.test",)
    response = await client_response(
        deps,
        method,
        path,
        headers={"Origin": "https://app.test", "Authorization": "Bearer t"},
    )
    assert response.status_code == status
    assert response.json() == {"error": {"code": code, "uncertain": False}}
    assert response.headers["Access-Control-Allow-Origin"] == "https://app.test"
    assert response.headers["Cache-Control"] == "no-store"
    assert "location" not in response.headers
    adapter.authenticate.assert_not_awaited()
    deps.extract_entry.assert_not_awaited()


@pytest.mark.parametrize("path", ["/health", "/semantic-entry", "/unknown"])
async def test_preflight_and_origin_rejection_preserved(setup, path):
    deps, _ = setup
    deps.allowed_origins = ("https://app.test",)
    allowed = await client_response(
        deps, "OPTIONS", path, headers={"Origin": "https://app.test"}
    )
    assert allowed.status_code == 204
    assert allowed.headers["Access-Control-Allow-Methods"] == "GET, POST, OPTIONS"
    denied = await client_response(
        deps, "OPTIONS", path, headers={"Origin": "https://evil.test"}
    )
    assert denied.status_code == 403
    assert denied.json() == {"error": {"code": "origin_forbidden", "uncertain": False}}


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
    health = await client_response(deps, "GET", "/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    deps.extract_entry.assert_not_awaited()
    adapter.authenticate.assert_not_awaited()
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


@pytest.mark.parametrize("streaming", [False, True])
async def test_failure_logs_node_and_safe_message_without_changing_wire(
    setup, streaming
):
    deps, adapter = setup
    deps.extract_entry.side_effect = SemanticError(502, "provider_error")
    response = await client_response(
        deps,
        json=REQUEST,
        headers={
            "Authorization": "Bearer private-token",
            "Accept": "text/event-stream" if streaming else "application/json",
        },
    )
    if streaming:
        assert response.status_code == 200
        assert '"code":"provider_error","uncertain":false' in response.text
    else:
        assert response.status_code == 502
        assert response.json() == {
            "error": {"code": "provider_error", "uncertain": False}
        }
    errors = [
        call.args[0]
        for call in deps.log.call_args_list
        if call.args[0]["status"] == "error"
    ]
    assert len(errors) == 1
    assert errors[0]["node"] == "extract"
    assert errors[0]["requestId"] == REQUEST_ID
    assert errors[0]["errorCode"] == "provider_error"
    assert errors[0]["errorMessage"]
    assert errors[0]["severity"] == "ERROR"
    adapter.persist_expense.assert_not_awaited()


async def test_unexpected_exception_is_logged_without_private_exception_text(setup):
    deps, _ = setup
    deps.extract_entry.side_effect = ValueError("private-token a@example.test 午餐851")
    with pytest.raises(ValueError):
        await invoke(REQUEST, "private-token", deps)
    event = deps.log.call_args.args[0]
    assert event["node"] == "extract" and event["errorCode"] == "service_error"
    assert event["exceptionType"] == "ValueError"
    assert not any(
        secret in str(event) for secret in ("private-token", "a@example", "午餐")
    )


async def test_failure_logger_exception_does_not_replace_service_error(setup):
    deps, _ = setup
    deps.log.side_effect = RuntimeError("logger unavailable")
    deps.extract_entry.side_effect = SemanticError(502, "provider_error")
    with pytest.raises(SemanticError) as exc:
        await invoke(REQUEST, "t", deps)
    assert exc.value.code == "provider_error"


@pytest.mark.parametrize("streaming", [False, True])
async def test_real_provider_failure_reaches_structured_log(setup, streaming):
    from semantic_entry.provider import Provider

    deps, _ = setup
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                400,
                json={
                    "error": {
                        "status": "INVALID_ARGUMENT",
                        "message": "Invalid value at 'generation_config.response_format.text.mime_type': private-token 午餐851",
                    }
                },
            )
        )
    ) as provider_client:
        provider = Provider(provider_client, "private-key")
        deps.extract_entry = provider
        deps.stream_entry = provider.stream
        await client_response(
            deps,
            json=REQUEST,
            headers={
                "Authorization": "Bearer private-token",
                "Accept": "text/event-stream; semantic-version=2"
                if streaming
                else "application/json",
            },
        )
    event = deps.log.call_args.args[0]
    assert event["errorCode"] == "provider_error" and event["node"] == "extract"
    assert event["upstreamHttpStatus"] == 400
    assert event["upstreamCode"] == "INVALID_ARGUMENT"
    assert (
        event["errorMessage"]
        == "Gemini rejected parameter: generation_config.response_format.text.mime_type."
    )
    assert not any(
        secret in str(event)
        for secret in ("private-token", "private-key", "午餐", "a@example")
    )


@pytest.mark.parametrize(
    "method,node",
    [
        ("authenticate", "authenticate"),
        ("load_context", "load_context"),
        ("lookup_completed", "lookup"),
        ("consume_quota", "quota"),
        ("persist_expense", "persist"),
    ],
)
async def test_failure_identifies_database_stage(setup, method, node):
    deps, adapter = setup
    getattr(adapter, method).side_effect = SemanticError(502, "database_error")
    with pytest.raises(SemanticError):
        await invoke(REQUEST, "private-token", deps)
    assert deps.log.call_args.args[0]["node"] == node
    assert deps.log.call_args.args[0]["errorCode"] == "database_error"


async def test_status_lookup_failure_has_sanitized_log(setup):
    deps, adapter = setup
    adapter.lookup_completed.side_effect = SemanticError(502, "database_error")
    response = await client_response(
        deps,
        method="GET",
        path=f"/semantic-entry/{REQUEST_ID}",
        headers={"Authorization": "Bearer private-token"},
    )
    assert response.status_code == 502
    event = deps.log.call_args.args[0]
    assert event["node"] == "lookup" and event["requestId"] == REQUEST_ID
    assert event["errorCode"] == "database_error"


async def test_stream_request_timeout_is_logged(setup):
    deps, _ = setup
    deps.http_deadline = 0.02

    async def slow_extract(text, context):
        await asyncio.sleep(1)

    deps.extract_entry = slow_extract
    response = await client_response(
        deps,
        json=REQUEST,
        headers={"Authorization": "Bearer t", "Accept": "text/event-stream"},
    )
    assert response.status_code == 200 and '"code":"persist_uncertain"' in response.text
    errors = [
        call.args[0]
        for call in deps.log.call_args_list
        if call.args[0]["status"] == "error"
    ]
    assert len(errors) == 1 and errors[0]["node"] == "deadline"
    assert errors[0]["errorCode"] == "persist_uncertain"


@pytest.mark.parametrize("streaming", [False, True])
async def test_adapter_initialization_failure_is_logged(setup, streaming):
    deps, _ = setup
    deps.create_adapter.side_effect = RuntimeError("private-token initialization")
    response = await client_response(
        deps,
        json=REQUEST,
        headers={
            "Authorization": "Bearer private-token",
            "Accept": "text/event-stream" if streaming else "application/json",
        },
    )
    assert response.status_code == (200 if streaming else 502)
    event = deps.log.call_args.args[0]
    assert event["node"] == "initialize" and event["errorCode"] == "service_error"
    assert "private-token" not in str(event)
