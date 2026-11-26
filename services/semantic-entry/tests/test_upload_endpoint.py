import asyncio
import importlib
from datetime import datetime
from unittest.mock import patch
from uuid import UUID

import httpx
import pytest
from fakes_images import FakeImageStore

from semantic_entry import server
from semantic_entry.errors import SemanticError
from semantic_entry.images import MAX_IMAGE_BYTES
from semantic_entry.server import create_app

FILE = {"contentType": "image/jpeg", "size": 3}


async def response(
    deps, method="POST", *, headers=None, path="/semantic-entry/uploads", **kwargs
):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://test"
    ) as client:
        return await client.request(
            method,
            path,
            headers={"Authorization": "Bearer synthetic", **(headers or {})},
            **kwargs,
        )


@pytest.fixture
def uploads(setup):
    deps, adapter = setup
    store = FakeImageStore()
    deps.image_store = store
    return deps, adapter, store


@pytest.mark.parametrize("count", [1, 2, 3, 4])
async def test_success_count_order_paths_and_no_quota(uploads, count):
    deps, adapter, store = uploads
    types = ["image/jpeg", "image/png", "image/webp", "image/jpeg"][:count]
    result = await response(
        deps,
        json={"files": [{"contentType": mime, "size": 1} for mime in types]},
        headers={"Accept": "text/event-stream; semantic-version=3"},
    )
    assert result.status_code == 200
    assert result.headers["content-type"] == "application/json"
    entries = result.json()["uploads"]
    assert len(entries) == count
    extensions = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
    for entry, mime in zip(entries, types, strict=True):
        assert set(entry) == {"path", "url", "expiresAt", "requiredHeaders"}
        prefix, user, filename = entry["path"].split("/")
        identifier, ext = filename.rsplit(".", 1)
        assert prefix == "uploads" and user == "a" and ext == extensions[mime]
        assert UUID(identifier).version == 4
        assert entry["expiresAt"].endswith("Z")
        datetime.fromisoformat(entry["expiresAt"])
        assert entry["requiredHeaders"] == {"Content-Type": mime}
        assert entry["url"] == "https://upload.example.test/synthetic"
    assert len({entry["path"] for entry in entries}) == count
    adapter.authenticate.assert_awaited_once()
    adapter.load_context.assert_awaited_once_with(adapter.authenticate.return_value)
    adapter.consume_quota.assert_not_awaited()
    adapter.lookup_completed.assert_not_awaited()
    adapter.persist_expense.assert_not_awaited()
    deps.extract_entry.assert_not_awaited()
    assert len(store.calls) == count
    assert "https://upload.example.test" not in str(deps.log.call_args_list)


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"files": []}, 400, "image_limit"),
        ({"files": [FILE] * 5}, 400, "image_limit"),
        ({"files": [{**FILE, "size": MAX_IMAGE_BYTES + 1}]}, 413, "image_too_large"),
        ({"files": [{**FILE, "size": MAX_IMAGE_BYTES}] * 3}, 400, "image_limit"),
        ({"files": [{**FILE, "contentType": "image/gif"}]}, 415, "image_unsupported"),
        ({"files": [FILE], "extra": True}, 400, "invalid_request"),
        ({"files": [{**FILE, "extra": True}]}, 400, "invalid_request"),
        ({"files": [{"contentType": "image/jpeg"}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": 1.0}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": 1.5}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": True}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": "3"}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": 0}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "size": -1}]}, 400, "invalid_request"),
        ({"files": [{**FILE, "contentType": []}]}, 400, "invalid_request"),
        ({"files": "wrong"}, 400, "invalid_request"),
        ({"files": [None]}, 400, "invalid_request"),
        ([], 400, "invalid_request"),
        ({}, 400, "invalid_request"),
    ],
)
async def test_invalid_upload_requests(uploads, body, status, code):
    deps, adapter, store = uploads
    result = await response(deps, json=body)
    assert result.status_code == status
    assert result.json() == {"error": {"code": code, "uncertain": False}}
    assert store.calls == []
    adapter.consume_quota.assert_not_awaited()
    deps.extract_entry.assert_not_awaited()


async def test_upload_size_boundaries(uploads):
    deps, _, _ = uploads
    result = await response(
        deps, json={"files": [{**FILE, "size": MAX_IMAGE_BYTES}] * 2}
    )
    assert result.status_code == 200


@pytest.mark.parametrize(
    "content", [b"{", b"\xff", b'{"files":[{"contentType":"image/jpeg","size":NaN}]}']
)
@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_bad_json(uploads, content, endpoint):
    deps, _, store = uploads
    result = await response(deps, path=endpoint, content=content)
    assert result.status_code == 400
    assert result.json()["error"]["code"] == "invalid_request"
    assert store.calls == []


@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_body_limit_counts_streamed_bytes(uploads, endpoint):
    deps, _, store = uploads

    async def body():
        yield b" " * 4096
        yield b" "

    result = await response(deps, path=endpoint, content=body())
    assert result.status_code == 400
    assert result.json()["error"]["code"] == "body_too_large"
    # Exactly 4096 bytes is parsed, rather than rejected as too large.
    result = await response(deps, path=endpoint, content=b" " * 4096)
    assert result.json()["error"]["code"] == "invalid_request"
    assert store.calls == []


@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_bearer_and_allowlist_required(uploads, endpoint):
    deps, adapter, store = uploads
    result = await response(
        deps, path=endpoint, headers={"Authorization": ""}, json={"files": [FILE]}
    )
    assert result.status_code == 401
    adapter.authenticate.assert_not_awaited()
    adapter.authenticate.side_effect = SemanticError(401, "unauthorized")
    result = await response(deps, path=endpoint, json={"files": [FILE]})
    assert result.status_code == 401
    adapter.load_context.assert_not_awaited()
    adapter.authenticate.side_effect = None
    adapter.load_context.side_effect = SemanticError(403, "forbidden")
    result = await response(deps, path=endpoint, json={"files": [FILE]})
    assert result.status_code == 403
    assert result.json()["error"]["code"] == "forbidden"
    assert store.calls == []
    adapter.consume_quota.assert_not_awaited()


@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_missing_configuration(setup, endpoint):
    deps, adapter = setup
    result = await response(deps, path=endpoint, json={"files": [FILE]})
    assert result.status_code == 502
    assert result.json()["error"]["code"] == "image_configuration"
    adapter.load_context.assert_awaited_once()
    adapter.consume_quota.assert_not_awaited()


@pytest.mark.parametrize(
    "method", ["GET", "PUT", "PATCH", "DELETE", "HEAD", "TRACE", "CONNECT"]
)
@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_non_post_methods_are_405(uploads, method, endpoint):
    deps, adapter, store = uploads
    result = await response(deps, method, path=endpoint)
    assert result.status_code == 405
    adapter.authenticate.assert_not_awaited()
    assert store.calls == []


@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_preflight_and_origin_preserved(uploads, endpoint):
    deps, adapter, _ = uploads
    deps.allowed_origins = ("https://app.example.test",)
    result = await response(
        deps, "OPTIONS", path=endpoint, headers={"Origin": "https://app.example.test"}
    )
    assert result.status_code == 204
    assert result.headers["Access-Control-Allow-Origin"] == "https://app.example.test"
    result = await response(
        deps, path=endpoint, headers={"Origin": "https://denied.example.test"}
    )
    assert result.status_code == 403
    adapter.authenticate.assert_not_awaited()


@pytest.mark.parametrize(
    "endpoint", ["/semantic-entry/uploads", "/semantic-entry/uploads/urls"]
)
async def test_upload_deadline_includes_body(uploads, endpoint):
    deps, adapter, store = uploads
    deps.http_deadline = 0.01

    async def body():
        yield b"{"
        await asyncio.sleep(1)

    result = await response(deps, path=endpoint, content=body())
    assert result.status_code == 504
    assert result.json() == {"error": {"code": "image_error", "uncertain": False}}
    assert store.calls == []
    adapter.consume_quota.assert_not_awaited()


async def test_upload_deadline_includes_signing_and_sanitizes_errors(uploads):
    deps, _, store = uploads
    deps.http_deadline = 0.01

    async def slow(*args):
        await asyncio.sleep(1)

    store.signed_upload_url = slow
    result = await response(deps, json={"files": [FILE]})
    assert result.status_code == 504

    async def failed(*args):
        raise RuntimeError("https://private.example.test/token")

    store.signed_upload_url = failed
    result = await response(deps, json={"files": [FILE]})
    assert result.status_code == 502
    assert "private.example.test" not in str(deps.log.call_args_list)
    assert "private.example.test" not in result.text


@pytest.mark.parametrize("bucket", [None, "synthetic-bucket"])
async def test_import_create_and_startup_do_not_acquire_credentials(bucket):
    # Replace the environment wholesale: no real model key or ADC is inspected.
    environment = {} if bucket is None else {"SEMANTIC_UPLOAD_BUCKET": bucket}
    with (
        patch.object(server.os, "environ", environment),
        patch("google.cloud.storage.Client") as client,
        patch("google.auth.default") as auth,
    ):
        importlib.reload(server)
        app = server.create_app()
        async with app.router.lifespan_context(app):
            assert (app.state.deps.image_store is None) == (bucket is None)
        client.assert_not_called()
        auth.assert_not_called()


@pytest.mark.parametrize("count", [1, 4])
async def test_read_urls_order_and_resigning(uploads, count):
    deps, adapter, store = uploads
    paths = [f"uploads/a/{i}.jpg" for i in reversed(range(count))]
    for path in paths:
        store.add(path)
    for _ in range(2):
        result = await response(
            deps, path="/semantic-entry/uploads/urls", json={"paths": paths}
        )
        assert result.status_code == 200
        assert result.json() == {
            "images": [
                {
                    "path": p,
                    "url": f"https://read.example.test/{p}",
                    "expiresAt": "2026-10-28T00:15:00Z",
                }
                for p in paths
            ]
        }
        assert result.headers["Cache-Control"] == "no-store"
    assert (
        store.calls
        == [call for p in paths for call in [("metadata", p), ("sign_read", p)]] * 2
    )
    adapter.consume_quota.assert_not_awaited()
    adapter.lookup_completed.assert_not_awaited()
    deps.extract_entry.assert_not_awaited()


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"paths": []}, 400, "image_limit"),
        ({"paths": [f"uploads/a/{i}.jpg" for i in range(5)]}, 400, "image_limit"),
        ({"paths": ["uploads/a/a.jpg"] * 2}, 400, "invalid_request"),
        ({"paths": "uploads/a/a.jpg"}, 400, "invalid_request"),
        ({"paths": [None]}, 400, "invalid_request"),
        ({"paths": [1]}, 400, "invalid_request"),
        ({"paths": ["uploads/a/a.jpg"], "extra": 1}, 400, "invalid_request"),
        ({}, 400, "invalid_request"),
        ([], 400, "invalid_request"),
        (
            {"paths": ["uploads/a/ok.jpg", "uploads/b/a.jpg"]},
            403,
            "image_forbidden_path",
        ),
        (
            {"paths": ["uploads/a/ok.jpg", "uploads/a/../b.jpg"]},
            403,
            "image_forbidden_path",
        ),
    ],
)
async def test_invalid_read_urls_before_storage(uploads, body, status, code):
    deps, _, store = uploads
    result = await response(deps, path="/semantic-entry/uploads/urls", json=body)
    assert result.status_code == status
    assert result.json() == {"error": {"code": code, "uncertain": False}}
    assert store.calls == []


async def test_read_urls_missing_object(uploads):
    deps, _, store = uploads
    result = await response(
        deps,
        path="/semantic-entry/uploads/urls",
        json={"paths": ["uploads/a/missing.jpg"]},
    )
    assert result.status_code == 404
    assert result.json()["error"]["code"] == "image_not_found"
    assert store.calls == [("metadata", "uploads/a/missing.jpg")]


@pytest.mark.parametrize("operation", ["metadata", "signed_read_url"])
async def test_read_urls_deadline_and_sanitized_errors(uploads, operation):
    deps, _, store = uploads
    path = "uploads/a/a.jpg"
    store.add(path)
    deps.http_deadline = 0.01

    async def slow(*args):
        await asyncio.sleep(1)

    setattr(store, operation, slow)
    result = await response(
        deps, path="/semantic-entry/uploads/urls", json={"paths": [path]}
    )
    assert result.status_code == 504
    assert result.json() == {"error": {"code": "image_error", "uncertain": False}}

    async def failed(*args):
        raise RuntimeError("https://private.example.test/token")

    setattr(store, operation, failed)
    result = await response(
        deps, path="/semantic-entry/uploads/urls", json={"paths": [path]}
    )
    assert result.status_code == 502
    assert "private.example.test" not in result.text + str(deps.log.call_args_list)
