import asyncio
import json

import httpx
import pytest
from conftest import CONTEXT, RAW, REQUEST_ID, ROW

from semantic_entry.errors import SemanticError
from semantic_entry.provider import Provider
from semantic_entry.supabase import SupabaseAdapter

COMPLETED = {
    "candidates": [
        {"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(RAW)}]}}
    ]
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
    assert calls[0].url.host == "generativelanguage.googleapis.com"
    assert calls[0].headers["x-goog-api-key"] == "synthetic"
    assert not calls[0].url.query and "authorization" not in calls[0].headers
    config = body["generationConfig"]
    assert config["maxOutputTokens"] == 800 and config["candidateCount"] == 1
    assert config["thinkingConfig"] == {"thinkingLevel": "MINIMAL"}
    assert "tools" not in body and "cachedContent" not in body
    assert config["responseFormat"]["text"]["mimeType"] == "application/json"
    assert not config["responseFormat"]["text"]["schema"]["additionalProperties"]
    assert body["contents"] == [{"role": "user", "parts": [{"text": "午餐851"}]}]
    assert "未信任" in body["systemInstruction"]["parts"][0]["text"]
    assert (
        result["raw"] == RAW
        and result["inputTokens"] is None
        and result["outputTokens"] is None
    )


@pytest.mark.parametrize(
    "payload,code",
    [
        ({"candidates": []}, "provider_invalid"),
        ({"promptFeedback": {"blockReason": "SAFETY"}}, "provider_refusal"),
        ({"candidates": [{"finishReason": "SAFETY"}]}, "provider_refusal"),
        ({"candidates": [{"finishReason": "MAX_TOKENS"}]}, "provider_invalid"),
        (
            {
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": "not json"}]},
                    }
                ]
            },
            "provider_invalid",
        ),
        (
            {
                "candidates": [
                    {"finishReason": "STOP", "content": {"parts": [{"text": "{}"}]}}
                ]
            },
            "provider_invalid",
        ),
        ([], "provider_invalid"),
        ({"candidates": COMPLETED["candidates"] * 2}, "provider_invalid"),
        (
            {
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"functionCall": {}}]},
                    }
                ]
            },
            "provider_invalid",
        ),
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
        {"promptTokenCount": True, "candidatesTokenCount": -1},
        {"promptTokenCount": 1.5, "candidatesTokenCount": "2"},
    ],
)
async def test_unknown_usage_stays_null(usage):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={**COMPLETED, "usageMetadata": usage})
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
            client, "https://synthetic.test", "synthetic-public", {}, "t"
        )
        with pytest.raises(SemanticError) as exc:
            await adapter.persist_expense(REQUEST_ID, "a" * 64, {})
    assert exc.value.status == expected and exc.value.uncertain == uncertain


async def test_adapter_transport_error_is_uncertain():
    def mock(request):
        raise httpx.ReadTimeout("synthetic")

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        adapter = SupabaseAdapter(
            client, "https://synthetic.test", "synthetic-public", {}, "t"
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
            client, "https://synthetic.test", "synthetic-public", {}, "t"
        )
        adapter.verified = {"id": "a", "email": "a@example.test"}
        with pytest.raises(SemanticError) as exc:
            await adapter.load_context(adapter.verified)
    assert exc.value.status == 403


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
async def test_non_json_numeric_constants_are_provider_errors(constant):
    extraction = json.dumps(RAW).replace('"amount": 851', '"amount": ' + constant)
    data = {
        "candidates": [
            {"finishReason": "STOP", "content": {"parts": [{"text": extraction}]}}
        ]
    }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=data))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic")("test", CONTEXT)
    assert exc.value.status == 502 and exc.value.code == "provider_invalid"


@pytest.mark.parametrize(
    "meta", [{}, {"來源": ["語意", 1, None]}, [1, True], None, 42, "legacy"]
)
async def test_database_jsonb_metadata_on_create_and_recovery(meta):
    row = {**ROW, "meta": meta}
    expected_meta = (
        meta
        if isinstance(meta, str)
        else json.dumps(
            meta, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
    )

    def mock(request):
        data = (
            {"expense": row, "replayed": False}
            if "create_semantic" in request.url.path
            else [{"input_hash": "a" * 64, "result": row}]
        )
        return httpx.Response(200, json=data)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        adapter = SupabaseAdapter(
            client, "https://synthetic.test", "synthetic-public", {}, "t"
        )
        adapter.verified = {"id": "a", "email": "a@example.test"}
        created = await adapter.persist_expense(REQUEST_ID, "a" * 64, {})
        replay = await adapter.lookup_completed(REQUEST_ID, "a" * 64)
    assert created == {"expense": {**ROW, "meta": expected_meta}, "replayed": False}
    assert replay == {"expense": {**ROW, "meta": expected_meta}, "replayed": True}
    assert row["meta"] == meta


async def test_gemini_split_text_ignores_thoughts_and_counts_usage():
    text = json.dumps(RAW)
    data = {
        "candidates": [
            {
                "finishReason": "STOP",
                "content": {
                    "parts": [
                        {"thought": True, "text": "synthetic thinking"},
                        {"text": text[:20]},
                        {"text": text[20:], "thoughtSignature": "synthetic"},
                    ]
                },
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 40,
            "thoughtsTokenCount": 5,
        },
    }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=data))
    ) as client:
        result = await Provider(client, "synthetic")("test", CONTEXT)
    assert result["raw"] == RAW
    assert result["inputTokens"] == 100 and result["outputTokens"] == 45


async def test_legacy_flash_thinking_budget():
    calls = []

    def mock(request):
        calls.append(request)
        return httpx.Response(200, json=COMPLETED)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        await Provider(client, "synthetic", "gemini-2.5-flash")("test", CONTEXT)
    assert json.loads(calls[0].content)["generationConfig"]["thinkingConfig"] == {
        "thinkingBudget": 0
    }


@pytest.mark.parametrize(
    "key,model",
    [
        ("", "gemini-3.5-flash-lite"),
        ("synthetic", "../escape"),
        ("synthetic", "gpt-5.4-mini"),
    ],
)
async def test_gemini_configuration_fails_without_network(key, model):
    def mock(request):
        pytest.fail("Invalid configuration must not call provider")

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, key, model)("test", CONTEXT)
    assert exc.value.code == "provider_configuration"


@pytest.mark.parametrize("status", [401, 429, 500])
async def test_gemini_http_errors_do_not_retry(status):
    calls = []

    def mock(request):
        calls.append(request)
        return httpx.Response(
            status, json={"error": {"message": "private provider details"}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic")("test", CONTEXT)
    assert exc.value.code == "provider_error" and len(calls) == 1
    assert "private" not in str(exc.value)


async def test_runtime_uses_gemini_key_and_configured_model(monkeypatch):
    from semantic_entry.server import environment_dependencies

    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-gemini")
    monkeypatch.setenv("OPENAI_API_KEY", "unused-synthetic-openai")
    monkeypatch.setenv("SEMANTIC_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("SEMANTIC_MEMBER_NAMES", "{}")
    calls = []

    def mock(request):
        calls.append(request)
        return httpx.Response(200, json=COMPLETED)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        result = await environment_dependencies(client).extract_entry("test", CONTEXT)
    assert result["model"] == "gemini-3.8-flash"
    assert calls[0].headers["x-goog-api-key"] == "synthetic-gemini"
    assert json.loads(calls[0].content)["generationConfig"]["thinkingConfig"] == {
        "thinkingLevel": "LOW"
    }
