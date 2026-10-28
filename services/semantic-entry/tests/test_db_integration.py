"""Explicit opt-in, localhost-only disposable SQL tests (never production)."""

import asyncio
import base64
import hashlib
import hmac
import json
import os
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from conftest import ROW


def local_url(value):
    parsed = urlparse(value)
    if (
        parsed.scheme not in ("http", "https")
        or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Integration tests require an explicit localhost Supabase URL")
    return value.rstrip("/")


def jwt(role, email=None, sub=None):
    def encode(value):
        return base64.urlsafe_b64encode(
            json.dumps(value, separators=(",", ":")).encode()
        ).rstrip(b"=")

    body = (
        encode({"alg": "HS256", "typ": "JWT"})
        + b"."
        + encode({"role": role, "email": email, "sub": sub, "exp": 4102444800})
    )
    signature = hmac.new(
        b"synthetic-local-test-secret-at-least-32-characters", body, hashlib.sha256
    ).digest()
    return (body + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")).decode()


def payload(email="a@example.test"):
    return {
        "note": "synthetic integration",
        "amount": 851,
        "currency": "TWD",
        "ts": "2026-03-01T16:00:00.000Z",
        "payer_email": email,
        "scope": "personal",
        "shares_json": {email: 851},
        "category_id": ROW["category_id"],
        "is_settled": True,
    }


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def db():
    # Fail closed before obtaining credentials, clients or performing mutations.
    url = local_url(os.environ.get("TEST_SUPABASE_URL", os.environ.get("API_URL", "")))
    standalone = os.environ.get("TEST_STANDALONE_POSTGREST") == "1"
    key = (
        jwt("anon")
        if standalone
        else os.environ.get("TEST_SUPABASE_ANON_KEY", os.environ.get("ANON_KEY", ""))
    )
    service_key = (
        jwt("service_role")
        if standalone
        else os.environ.get(
            "TEST_SUPABASE_SERVICE_KEY", os.environ.get("SERVICE_ROLE_KEY", "")
        )
    )
    prefix = "" if standalone else "/rest/v1"
    if not key or not service_key:
        raise ValueError("Local test keys required")
    async with httpx.AsyncClient(
        base_url=url, timeout=30, limits=httpx.Limits(max_connections=120)
    ) as client:

        async def call(role, method, path, body=None, params=None):
            token = {"admin": service_key, "anon": key}.get(role, tokens.get(role, key))
            return await client.request(
                method,
                prefix + path,
                json=body,
                params=params,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {token}",
                    "Prefer": "return=representation",
                },
            )

        tokens = {}
        for letter in ("a", "b"):
            email = f"{letter}@example.test"
            if standalone:
                tokens[letter] = jwt(
                    "authenticated",
                    email,
                    f"{letter * 8}-{letter * 4}-4{letter * 3}-8{letter * 3}-{letter * 12}",
                )
            else:
                headers = {"apikey": key}
                body = {"email": email, "password": "Synthetic-only-test-password-573!"}
                signed = await client.post(
                    "/auth/v1/token?grant_type=password", headers=headers, json=body
                )
                if not signed.is_success:
                    signed = await client.post(
                        "/auth/v1/signup", headers=headers, json=body
                    )
                signed.raise_for_status()
                tokens[letter] = signed.json()["access_token"]
        for table in ("semantic_entry_requests", "semantic_entry_quota", "expenses"):
            column = "id" if table == "expenses" else "user_id"
            result = await call(
                "admin", "DELETE", f"/{table}", params={column: "not.is.null"}
            )
            result.raise_for_status()
        yield call


async def create(db, role, identifier, expense=None, digest="a" * 64):
    return await db(
        role,
        "POST",
        "/rpc/create_semantic_expense",
        {
            "p_request_id": identifier,
            "p_input_hash": digest,
            "p_expense": expense or payload(),
        },
    )


pytestmark = pytest.mark.asyncio(loop_scope="module")


async def test_concurrent_matching_requests(db):
    identifier = str(uuid4())
    responses = await asyncio.gather(*(create(db, "a", identifier) for _ in range(20)))
    assert all(r.is_success for r in responses)
    results = [r.json() for r in responses]
    assert len({r["expense"]["id"] for r in results}) == 1
    assert sum(not r["replayed"] for r in results) == 1
    rows = await db(
        "admin", "GET", "/expenses", params={"id": f"eq.{results[0]['expense']['id']}"}
    )
    assert len(rows.json()) == 1


async def test_hash_and_user_isolation(db):
    identifier = str(uuid4())
    first = await create(db, "a", identifier)
    assert first.is_success
    conflict = await create(db, "a", identifier, digest="b" * 64)
    assert conflict.status_code == 409 and conflict.json()["code"] == "PT409"
    second = await create(db, "b", identifier, payload("b@example.test"))
    assert (
        second.is_success
        and first.json()["expense"]["id"] != second.json()["expense"]["id"]
    )
    rows = await db(
        "b",
        "GET",
        "/semantic_entry_requests",
        params={"expense_id": f"eq.{first.json()['expense']['id']}"},
    )
    assert rows.is_success and rows.json() == []


@pytest.mark.parametrize(
    "patch",
    [
        {"amount": -1},
        {"currency": "USD"},
        {"amount": 1.5},
        {"payer_email": "b@example.test"},
        {"is_settled": False},
        {"shares_json": {"unknown@example.test": 851}},
        {
            "scope": "household",
            "is_settled": False,
            "shares_json": {"a@example.test": 850, "b@example.test": 1},
        },
        {"ts": "2026-03-01T17:00:00Z"},
        {"note": "fixture_insert_failure"},
    ],
)
async def test_failed_write_rolls_back(db, patch):
    before = await db("admin", "GET", "/expenses", params={"select": "id"})
    identifier = str(uuid4())
    failed = await create(db, "a", identifier, {**payload(), **patch})
    assert not failed.is_success
    ledger = await db(
        "admin",
        "GET",
        "/semantic_entry_requests",
        params={"request_id": f"eq.{identifier}"},
    )
    after = await db("admin", "GET", "/expenses", params={"select": "id"})
    assert ledger.is_success and ledger.json() == [] and after.json() == before.json()


async def test_discarded_response_edits_and_deletion(db):
    identifier = str(uuid4())
    assert (await create(db, "a", identifier)).is_success
    replay = (await create(db, "a", identifier)).json()
    assert replay["replayed"]
    expense_id = replay["expense"]["id"]
    params = {"id": f"eq.{expense_id}"}
    assert (await db("a", "PATCH", "/expenses", {"note": "edited"}, params)).is_success
    assert (await create(db, "a", identifier)).json()["expense"][
        "note"
    ] == "synthetic integration"
    assert (await db("a", "GET", "/expenses", params=params)).json()[0][
        "note"
    ] == "edited"
    assert (await db("a", "DELETE", "/expenses", params=params)).is_success
    assert (await create(db, "a", identifier)).json()["expense"]["id"] == expense_id
    assert (await db("a", "GET", "/expenses", params=params)).json() == []


async def test_denied_mutations_and_anonymous_rpc(db):
    for table in ("semantic_entry_requests", "semantic_entry_quota"):
        for method in ("POST", "PATCH", "DELETE"):
            response = await db(
                "a",
                method,
                f"/{table}",
                {"user_id": str(uuid4())} if method != "DELETE" else None,
                {"user_id": "not.is.null"} if method != "POST" else None,
            )
            assert not response.is_success
    assert not (await create(db, "anon", str(uuid4()))).is_success
    assert not (
        await db("anon", "POST", "/rpc/consume_semantic_entry_quota", {})
    ).is_success


async def test_101_quota_attempts(db):
    responses = await asyncio.gather(
        *(db("a", "POST", "/rpc/consume_semantic_entry_quota", {}) for _ in range(101))
    )
    assert all(r.is_success for r in responses)
    assert sum(r.json() is True for r in responses) == 100
    assert sum(r.json() is False for r in responses) == 1


async def create_batch(db, role, identifier, expenses, digest="a" * 64):
    return await db(
        role,
        "POST",
        "/rpc/create_semantic_expenses",
        {
            "p_request_id": identifier,
            "p_input_hash": digest,
            "p_expenses": expenses,
        },
    )


async def batch_expense_ids(db):
    response = await db("admin", "GET", "/expenses", params={"select": "id"})
    response.raise_for_status()
    return {row["id"] for row in response.json()}


async def test_batch_length_one_and_replay(db):
    before = await batch_expense_ids(db)
    identifier = str(uuid4())
    first = await create_batch(db, "a", identifier, [payload()])
    assert first.is_success, first.text
    result = first.json()
    assert result["replayed"] is False and len(result["expenses"]) == 1
    replay = await create_batch(db, "a", identifier, [payload()])
    assert replay.is_success
    assert replay.json() == {**result, "replayed": True}
    assert await batch_expense_ids(db) == before | {result["expenses"][0]["id"]}


async def test_batch_concurrent_matching_requests(db):
    before = await batch_expense_ids(db)
    identifier = str(uuid4())
    responses = await asyncio.gather(
        *(create_batch(db, "a", identifier, [payload(), payload()]) for _ in range(20))
    )
    assert all(response.is_success for response in responses)
    results = [response.json() for response in responses]
    assert sum(result["replayed"] is False for result in results) == 1
    ids = {expense["id"] for expense in results[0]["expenses"]}
    assert len(ids) == 2
    assert all(result["expenses"] == results[0]["expenses"] for result in results)
    assert await batch_expense_ids(db) == before | ids


async def test_batch_hash_conflict_and_user_isolation(db):
    identifier = str(uuid4())
    first = await create_batch(db, "a", identifier, [payload()])
    assert first.is_success
    conflict = await create_batch(db, "a", identifier, [payload()], digest="b" * 64)
    assert conflict.status_code == 409 and conflict.json()["code"] == "PT409"
    second = await create_batch(db, "b", identifier, [payload("b@example.test")])
    assert second.is_success and second.json()["replayed"] is False
    assert first.json()["expenses"][0]["id"] != second.json()["expenses"][0]["id"]
    ledger = await db(
        "b",
        "GET",
        "/semantic_entry_requests",
        params={"request_id": f"eq.{identifier}"},
    )
    assert ledger.is_success and len(ledger.json()) == 1
    assert ledger.json()[0]["result"]["expenses"] == second.json()["expenses"]


@pytest.mark.parametrize(
    "patch",
    [{"amount": 1.5}, {"currency": "USD"}, {"note": "fixture_insert_failure"}],
)
async def test_batch_failed_write_rolls_back(db, patch):
    before = await batch_expense_ids(db)
    identifier = str(uuid4())
    failed = await create_batch(
        db, "a", identifier, [payload(), {**payload(), **patch}]
    )
    assert not failed.is_success
    if patch.get("note") != "fixture_insert_failure":
        body = failed.json()
        assert failed.status_code == 422 and body["code"] == "PT422"
        assert json.loads(body["details"]) == {"index": 1}
        print("Batch PT422 response:", json.dumps(body, sort_keys=True))
    ledger = await db(
        "admin",
        "GET",
        "/semantic_entry_requests",
        params={"request_id": f"eq.{identifier}"},
    )
    assert ledger.is_success and ledger.json() == []
    assert await batch_expense_ids(db) == before


@pytest.mark.parametrize("size", [0, 21])
async def test_batch_invalid_length(db, size):
    identifier = str(uuid4())
    before = await batch_expense_ids(db)
    response = await create_batch(db, "a", identifier, [payload()] * size)
    assert response.status_code == 422 and response.json()["code"] == "PT422"
    assert response.json()["message"] == "Invalid expense batch"
    ledger = await db(
        "admin",
        "GET",
        "/semantic_entry_requests",
        params={"request_id": f"eq.{identifier}"},
    )
    assert ledger.is_success and ledger.json() == []
    assert await batch_expense_ids(db) == before


async def test_batch_anonymous_rpc_denied(db):
    response = await create_batch(db, "anon", str(uuid4()), [payload()])
    assert not response.is_success
