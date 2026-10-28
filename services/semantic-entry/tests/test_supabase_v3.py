import json
from copy import deepcopy

import httpx
import pytest
from conftest import CONTEXT, REQUEST_ID, ROW

from semantic_entry.errors import SemanticError
from semantic_entry.supabase import SupabaseAdapter


def adapter(client):
    a = SupabaseAdapter(
        client, "https://synthetic.test", "synthetic-public", {}, "synthetic-token"
    )
    a.verified = {"id": "a", "email": "a@example.test"}
    return a


@pytest.mark.parametrize("batch", [False, True])
async def test_lookup_single_batch_and_v2_version_guard(batch):
    snapshot = {"batch": True, "expenses": [ROW, ROW]} if batch else ROW
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, json=[{"input_hash": "a" * 64, "result": snapshot}]
            )
        )
    ) as client:
        a = adapter(client)
        saved = await a.lookup_completed_v3(REQUEST_ID, "a" * 64)
        assert saved == {"expenses": [ROW, ROW] if batch else [ROW], "replayed": True}
        with pytest.raises(SemanticError, match="conflict"):
            await a.lookup_completed_v3(REQUEST_ID, "b" * 64)
        if batch:
            with pytest.raises(SemanticError, match="unsupported_version"):
                await a.lookup_completed(REQUEST_ID)
        else:
            assert await a.lookup_completed(REQUEST_ID) == {
                "expense": ROW,
                "replayed": True,
            }


@pytest.mark.parametrize(
    "snapshot",
    [
        {"batch": True},
        {"batch": True, "expenses": []},
        {"batch": True, "expenses": [{}]},
        {"batch": False},
        None,
    ],
)
async def test_invalid_snapshot_database_invalid(snapshot):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json=[{"result": snapshot}])
        )
    ) as client:
        with pytest.raises(SemanticError, match="database_invalid"):
            await adapter(client).lookup_completed_v3(REQUEST_ID)


async def test_persist_batch_body_adapts_metadata():
    row = {**ROW, "meta": {"synthetic": True}}

    def mock(r):
        assert r.url.path == "/rest/v1/rpc/create_semantic_expenses"
        assert json.loads(r.content) == {
            "p_request_id": REQUEST_ID,
            "p_input_hash": "a" * 64,
            "p_expenses": [{}, {}],
        }
        return httpx.Response(200, json={"expenses": [row, row], "replayed": False})

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        result = await adapter(client).persist_expenses(REQUEST_ID, "a" * 64, [{}, {}])
    assert len(result["expenses"]) == 2
    assert result["expenses"][0]["meta"] == '{"synthetic":true}'


@pytest.mark.parametrize(
    "details,index",
    [
        ('{"index": 1}', 1),
        ("not JSON", None),
        (None, None),
        ('{"index": -1}', None),
        ('{"index": true}', None),
        ('{"index": 1.5}', None),
        ("[]", None),
    ],
)
async def test_pt422_row_index_json_string_only(details, index):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(422, json={"code": "PT422", "details": details})
        )
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await adapter(client).persist_expenses(REQUEST_ID, "a" * 64, [{}])
    assert (
        exc.value.status == 422
        and exc.value.code == "rpc_rejected"
        and not exc.value.uncertain
    )
    assert exc.value.diagnostics == ({} if index is None else {"rowIndex": index})


async def test_pt409_batch_is_certain_conflict():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(409, json={"code": "PT409"})
        )
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await adapter(client).persist_expenses(REQUEST_ID, "a" * 64, [{}])
    assert exc.value.code == "conflict" and not exc.value.uncertain


async def test_single_rpc_batch_snapshot_is_conflict_not_uncertain():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200,
                json={"expense": {"batch": True, "expenses": [ROW]}, "replayed": True},
            )
        )
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await adapter(client).persist_expense(REQUEST_ID, "a" * 64, {})
    assert (
        exc.value.status == 409
        and exc.value.code == "conflict"
        and not exc.value.uncertain
    )


@pytest.mark.parametrize(
    "result",
    [
        {},
        {"expenses": [ROW], "replayed": False},
        {"expenses": [{}, {}], "replayed": False},
        {"expenses": [ROW, ROW], "replayed": 1},
    ],
)
async def test_batch_bad_response_is_uncertain(result):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=result))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await adapter(client).persist_expenses(REQUEST_ID, "a" * 64, [{}, {}])
    assert exc.value.code == "persist_uncertain" and exc.value.uncertain


async def test_batch_transport_timeout_is_uncertain():
    def mock(r):
        raise httpx.ReadTimeout("synthetic")

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(SemanticError, match="persist_uncertain"):
            await adapter(client).persist_expenses(REQUEST_ID, "a" * 64, [{}])


async def test_context_uses_taiwan_today_at_utc_boundary(monkeypatch):
    from datetime import UTC, datetime

    import semantic_entry.supabase as module

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 2, 28, 16, 30, tzinfo=UTC).astimezone(tz)

    monkeypatch.setattr(module, "datetime", Clock)

    def mock(r):
        return httpx.Response(
            200,
            json=[{"allowed_emails": ["a@example.test"]}]
            if "app_settings" in r.url.path
            else deepcopy(CONTEXT["categories"]),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        a = adapter(client)
        assert (await a.load_context(a.verified))["today"] == "2026-03-01"
