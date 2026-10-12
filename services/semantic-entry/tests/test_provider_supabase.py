import asyncio
import json

import httpx
import pytest
from conftest import CONTEXT, RAW, REQUEST_ID, ROW

from semantic_entry.errors import SemanticError
from semantic_entry.provider import Provider
from semantic_entry.supabase import SupabaseAdapter

COMPLETED = {
    "status": "completed",
    "output": [
        {
            "type": "message",
            "content": [{"type": "output_text", "text": json.dumps(RAW)}],
        }
    ],
}


async def test_structured_provider():
    calls = []

    def mock(request):
        calls.append(request)
        return httpx.Response(200, json=COMPLETED)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        result = await Provider(client, "synthetic")("午餐851", CONTEXT)
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["max_output_tokens"] == 800 and body["reasoning"] == {"effort": "none"}
    assert body["store"] is False and "tools" not in body
    assert (
        body["text"]["format"]["strict"]
        and not body["text"]["format"]["schema"]["additionalProperties"]
    )
    assert (
        result["raw"] == RAW
        and result["inputTokens"] is None
        and result["outputTokens"] is None
    )


@pytest.mark.parametrize(
    "payload,code",
    [
        ({"status": "incomplete", "output": []}, "provider_invalid"),
        (
            {"status": "completed", "output": [{"content": [{"type": "refusal"}]}]},
            "provider_refusal",
        ),
        (
            {
                "status": "completed",
                "output": [{"content": [{"type": "output_text", "text": "not json"}]}],
            },
            "provider_invalid",
        ),
        (
            {
                "status": "completed",
                "output": [{"content": [{"type": "output_text", "text": "{}"}]}],
            },
            "provider_invalid",
        ),
        ([], "provider_invalid"),
    ],
)
async def test_provider_invalid_no_retry(payload, code):
    calls = []

    def mock(request):
        calls.append(request)
        return httpx.Response(200, json=payload)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic")("test", CONTEXT)
    assert exc.value.status == 502 and exc.value.code == code and len(calls) == 1


async def test_provider_timeout():
    calls = []

    async def mock(request):
        calls.append(request)
        await asyncio.sleep(1)
        return httpx.Response(200, json=COMPLETED)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        assert Provider(client, "synthetic").deadline == 15
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic", deadline=0.01)("test", CONTEXT)
    assert (
        exc.value.status == 504
        and exc.value.code == "provider_timeout"
        and len(calls) == 1
    )


@pytest.mark.parametrize(
    "usage",
    [
        {},
        {"input_tokens": True, "output_tokens": -1},
        {"input_tokens": 1.5, "output_tokens": "2"},
    ],
)
async def test_unknown_usage_stays_null(usage):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={**COMPLETED, "usage": usage})
        )
    ) as client:
        result = await Provider(client, "synthetic")("test", CONTEXT)
    assert result["inputTokens"] is None and result["outputTokens"] is None


async def test_adapter_caller_and_owner_filters():
    calls = []

    def mock(request):
        calls.append(request)
        assert request.headers["Authorization"] == "Bearer synthetic-caller"
        assert request.headers["apikey"] == "synthetic-public"
        path = request.url.path
        data = (
            {"id": "a", "email": "a@example.test"}
            if path == "/auth/v1/user"
            else (
                [{"allowed_emails": ["a@example.test", "b@example.test"]}]
                if "app_settings" in path
                else (
                    [{"id": "other", "name": "其他"}]
                    if "categories" in path
                    else (
                        True
                        if "consume_semantic" in path
                        else (
                            {"expense": ROW, "replayed": False}
                            if "create_semantic" in path
                            else [{"input_hash": "a" * 64, "result": ROW}]
                        )
                    )
                )
            )
        )
        return httpx.Response(200, json=data)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        adapter = SupabaseAdapter(
            client,
            "https://synthetic.test",
            "synthetic-public",
            {"a@example.test": "甲"},
            "other",
            "synthetic-caller",
        )
        user = await adapter.authenticate()
        assert len((await adapter.load_context(user))["members"]) == 2
        assert await adapter.lookup_completed(REQUEST_ID, "a" * 64) == {
            "expense": ROW,
            "replayed": True,
        }
        with pytest.raises(SemanticError) as exc:
            await adapter.lookup_completed(REQUEST_ID, "b" * 64)
        assert exc.value.status == 409
        assert await adapter.consume_quota() is True
        assert (await adapter.persist_expense(REQUEST_ID, "a" * 64, {}))[
            "expense"
        ] == ROW
    lookup = next(r for r in calls if "semantic_entry_requests" in r.url.path)
    assert (
        lookup.url.params["user_id"] == "eq.a"
        and lookup.url.params["request_id"] == f"eq.{REQUEST_ID}"
    )


@pytest.mark.parametrize(
    "status,data,expected,uncertain",
    [(409, {"code": "PT409"}, 409, False), (500, {}, 504, True), (200, {}, 504, True)],
)
async def test_persist_error_mapping(status, data, expected, uncertain):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(status, json=data))
    ) as client:
        adapter = SupabaseAdapter(
            client, "https://synthetic.test", "synthetic-public", {}, "other", "t"
        )
        with pytest.raises(SemanticError) as exc:
            await adapter.persist_expense(REQUEST_ID, "a" * 64, {})
    assert exc.value.status == expected and exc.value.uncertain == uncertain


async def test_adapter_transport_error_is_uncertain():
    def mock(request):
        raise httpx.ReadTimeout("synthetic")

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        adapter = SupabaseAdapter(
            client, "https://synthetic.test", "synthetic-public", {}, "other", "t"
        )
        with pytest.raises(SemanticError) as exc:
            await adapter.persist_expense(REQUEST_ID, "a" * 64, {})
    assert exc.value.uncertain


async def test_adapter_forbidden_member():
    def mock(request):
        data = (
            [{"allowed_emails": ["b@example.test"]}]
            if "app_settings" in request.url.path
            else []
        )
        return httpx.Response(200, json=data)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        adapter = SupabaseAdapter(
            client, "https://synthetic.test", "synthetic-public", {}, "other", "t"
        )
        adapter.verified = {"id": "a", "email": "a@example.test"}
        with pytest.raises(SemanticError) as exc:
            await adapter.load_context(adapter.verified)
    assert exc.value.status == 403


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
async def test_non_json_numeric_constants_are_provider_errors(constant):
    extraction = json.dumps(RAW).replace('"amount": 851', '"amount": ' + constant)
    data = {
        "status": "completed",
        "output": [{"content": [{"type": "output_text", "text": extraction}]}],
    }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=data))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic")("test", CONTEXT)
    assert exc.value.status == 502 and exc.value.code == "provider_invalid"
