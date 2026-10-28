import asyncio
import threading
from datetime import UTC, datetime
from unittest.mock import Mock, patch

import pytest
from fakes_images import FakeImageStore
from google.api_core.exceptions import NotFound, PreconditionFailed

from semantic_entry.errors import SemanticError, error_details
from semantic_entry.images import (
    MAX_IMAGE_BYTES,
    MAX_TOTAL_IMAGE_BYTES,
    UPLOAD_URL_TTL,
    GcsImageStore,
    check_owned_path,
    download_verified,
    read_verified_metadata,
)

PATH = "uploads/a/receipt.jpg"


@pytest.mark.parametrize(
    "path",
    [
        "uploads/b/receipt.jpg",
        "upload/a/receipt.jpg",
        "uploads/a/sub/receipt.jpg",
        "uploads/a/..",
        "uploads/a/a..jpg",
        "uploads/a/",
        "uploads/aa/receipt.jpg",
        "uploads/a/.jpg",
        "uploads/a/a.jpg\n",
        "uploads/a/" + "a" * 201,
    ],
)
async def test_ownership_before_any_storage_call(path):
    store = FakeImageStore()
    with pytest.raises(SemanticError) as caught:
        await read_verified_metadata(store, "a", [PATH, path])
    assert (caught.value.status, caught.value.code) == (403, "image_forbidden_path")
    assert store.calls == []


def test_path_ownership_escapes_identity_and_accepts_boundary():
    check_owned_path("a+", "uploads/a+/" + "a" * 200)
    with pytest.raises(SemanticError):
        check_owned_path("a+", "uploads/aa/file.jpg")


async def test_duplicate_paths_before_storage():
    store = FakeImageStore()
    with pytest.raises(SemanticError, match="invalid_request"):
        await read_verified_metadata(store, "a", [PATH, PATH])
    assert store.calls == []


@pytest.mark.parametrize(
    ("size", "mime", "expected"),
    [
        (None, "image/jpeg", (404, "image_not_found")),
        (0, "image/jpeg", (413, "image_too_large")),
        (MAX_IMAGE_BYTES + 1, "image/jpeg", (413, "image_too_large")),
        (1, "image/gif", (415, "image_unsupported")),
    ],
)
async def test_metadata_rejections(size, mime, expected):
    store = FakeImageStore()
    if size is not None:
        store.add(PATH, size=size, mime=mime)
    with pytest.raises(SemanticError) as caught:
        await read_verified_metadata(store, "a", [PATH])
    assert (caught.value.status, caught.value.code) == expected
    assert store.calls == [("metadata", PATH)]


async def test_metadata_size_boundaries_and_order():
    store = FakeImageStore()
    paths = [PATH, "uploads/a/second.jpg"]
    for path in paths:
        store.add(path, size=MAX_IMAGE_BYTES)
    result = await read_verified_metadata(store, "a", paths)
    assert [item.path for item in result] == paths
    assert sum(item.size for item in result) == MAX_TOTAL_IMAGE_BYTES
    store.add("uploads/a/third.jpg", size=1)
    with pytest.raises(SemanticError) as caught:
        await read_verified_metadata(store, "a", [*paths, "uploads/a/third.jpg"])
    assert (caught.value.status, caught.value.code) == (400, "image_limit")


async def test_metadata_reads_are_concurrent():
    store = FakeImageStore()
    entered = 0
    both = asyncio.Event()

    async def metadata(path):
        nonlocal entered
        entered += 1
        if entered == 2:
            both.set()
        await both.wait()
        return store.items[path]

    paths = [PATH, "uploads/a/second.jpg"]
    for path in paths:
        store.add(path)
    store.metadata = metadata
    assert (
        len(await asyncio.wait_for(read_verified_metadata(store, "a", paths), 1)) == 2
    )


@pytest.mark.parametrize(
    ("mime", "data"),
    [
        ("image/jpeg", b"\xff\xd8\xffsynthetic"),
        ("image/png", b"\x89PNG\r\n\x1a\nsynthetic"),
        ("image/webp", b"RIFF\x00\x00\x00\x00WEBPsynthetic"),
    ],
)
async def test_valid_signatures_and_generation_binding(mime, data):
    store = FakeImageStore()
    store.add(PATH, data, mime)
    metadata = await read_verified_metadata(store, "a", [PATH])
    assert await download_verified(store, metadata) == [(mime, data)]
    assert store.calls[-1] == ("download", PATH, "17")


async def test_changed_generation_rejected():
    store = FakeImageStore()
    item = store.add(PATH)
    store.add(PATH, generation="18")
    with pytest.raises(SemanticError) as caught:
        await download_verified(store, [item])
    assert (caught.value.status, caught.value.code) == (409, "image_changed")
    assert store.calls[-1] == ("download", PATH, "17")


async def test_changed_length_rejected():
    store = FakeImageStore()
    item = store.add(PATH, size=4)
    with pytest.raises(SemanticError) as caught:
        await download_verified(store, [item])
    assert (caught.value.status, caught.value.code) == (409, "image_changed")


@pytest.mark.parametrize(
    ("mime", "data"),
    [
        ("image/jpeg", b"\x89PNG\r\n\x1a\n"),
        ("image/png", b"\xff\xd8\xff"),
        ("image/webp", b"RIFF1234NOPE"),
        ("image/webp", b"RIFFWEBP"),
        ("image/jpeg", b"\xff\xd8"),
    ],
)
async def test_wrong_or_truncated_signature(mime, data):
    store = FakeImageStore()
    item = store.add(PATH, data, mime)
    with pytest.raises(SemanticError) as caught:
        await download_verified(store, [item])
    assert (caught.value.status, caught.value.code) == (415, "image_unsupported")


@pytest.fixture
def gcs():
    with (
        patch("google.cloud.storage.Client") as client,
        patch("google.auth.default") as auth,
        patch("semantic_entry.images.Request") as request,
    ):
        credentials = Mock(
            service_account_email="service@example.test", token="synthetic-token"
        )
        auth.return_value = (credentials, "synthetic-project")
        blob = client.return_value.bucket.return_value.blob.return_value
        blob.size = 3
        blob.content_type = "image/jpeg"
        blob.generation = 17
        blob.download_as_bytes.return_value = b"\xff\xd8\xff"
        blob.generate_signed_url.return_value = "https://upload.example.test/synthetic"
        yield client, blob, auth, credentials, request


async def test_gcs_lazy_and_generation_download_parameters(gcs):
    client, blob, auth, _, _ = gcs
    store = GcsImageStore("synthetic-bucket")
    client.assert_not_called()
    auth.assert_not_called()
    item = await store.metadata(PATH)
    assert item.path == PATH and item.size == 3 and item.generation == "17"
    blob.reload.assert_called_once_with()
    blob.download_as_bytes.assert_not_called()
    assert await store.download(PATH, item.generation) == b"\xff\xd8\xff"
    blob.download_as_bytes.assert_called_once_with(if_generation_match=17)
    client.assert_called_once_with()
    client.return_value.bucket.assert_called_with("synthetic-bucket")
    client.return_value.bucket.return_value.blob.assert_called_with(PATH)
    auth.assert_not_called()


async def test_gcs_v4_put_signing_parameters_and_offloop_work(gcs):
    client, blob, auth, credentials, request = gcs
    main_thread = threading.get_ident()
    threads = []
    client.side_effect = lambda: (
        threads.append(threading.get_ident()) or client.return_value
    )
    store = GcsImageStore("synthetic-bucket")
    before = datetime.now(UTC)
    result = await store.signed_upload_url(PATH, "image/png")
    after = datetime.now(UTC)
    kwargs = blob.generate_signed_url.call_args.kwargs
    assert kwargs == {
        "version": "v4",
        "method": "PUT",
        "content_type": "image/png",
        "expiration": kwargs["expiration"],
        "service_account_email": "service@example.test",
        "access_token": "synthetic-token",
    }
    assert before + UPLOAD_URL_TTL <= kwargs["expiration"] <= after + UPLOAD_URL_TTL
    assert result == {
        "url": "https://upload.example.test/synthetic",
        "expiresAt": kwargs["expiration"].isoformat().replace("+00:00", "Z"),
        "requiredHeaders": {"Content-Type": "image/png"},
    }
    auth.assert_called_once_with()
    credentials.refresh.assert_called_once_with(request.return_value)
    assert threads and main_thread not in threads


@pytest.mark.parametrize(
    ("exception", "status", "code"),
    [
        (PreconditionFailed("synthetic"), 409, "image_changed"),
        (NotFound("synthetic"), 404, "image_not_found"),
        (RuntimeError("private-storage-text"), 502, "image_error"),
    ],
)
async def test_gcs_download_exception_mapping(gcs, exception, status, code):
    _, blob, _, _, _ = gcs
    blob.download_as_bytes.side_effect = exception
    with pytest.raises(SemanticError) as caught:
        await GcsImageStore("synthetic").download(PATH, "17")
    assert (caught.value.status, caught.value.code) == (status, code)
    assert "private-storage-text" not in str(error_details(caught.value))


async def test_gcs_metadata_not_found_and_errors(gcs):
    _, blob, _, _, _ = gcs
    store = GcsImageStore("synthetic")
    blob.reload.side_effect = NotFound("synthetic")
    assert await store.metadata(PATH) is None
    blob.reload.side_effect = RuntimeError("private")
    with pytest.raises(SemanticError, match="image_error"):
        await store.metadata(PATH)


async def test_gcs_signing_error_sanitized(gcs):
    _, _, auth, _, _ = gcs
    auth.side_effect = RuntimeError("private-token")
    with pytest.raises(SemanticError, match="image_error") as caught:
        await GcsImageStore("synthetic").signed_upload_url(PATH, "image/jpeg")
    assert caught.value.status == 502
    assert "private-token" not in str(error_details(caught.value))
