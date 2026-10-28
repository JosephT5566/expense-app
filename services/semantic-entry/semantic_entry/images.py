"""Caller-owned uploads and generation-bound image verification."""

import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

import google.auth
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.auth.transport.requests import Request
from google.cloud import storage

from .contracts import JSON, exact_keys, object_
from .errors import SemanticError

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_FILES = 4
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
UPLOAD_URL_TTL = timedelta(minutes=15)


@dataclass(frozen=True)
class ImageMetadata:
    path: str
    size: int
    content_type: str
    generation: str


class ImageStore(Protocol):
    async def signed_upload_url(self, path: str, content_type: str) -> JSON: ...
    async def metadata(self, path: str) -> ImageMetadata | None: ...
    async def download(self, path: str, generation: str) -> bytes: ...


def check_owned_path(user_id: str, path: str) -> None:
    if ".." in path or not re.fullmatch(
        rf"uploads/{re.escape(user_id)}/[A-Za-z0-9][A-Za-z0-9._-]{{0,199}}", path
    ):
        raise SemanticError(403, "image_forbidden_path")


def parse_upload_request(raw: object) -> list[JSON]:
    try:
        request = object_(raw)
        exact_keys(request, ["files"])
        files = request["files"]
        if not isinstance(files, list):
            raise ValueError("Invalid files")
        if not 1 <= len(files) <= MAX_UPLOAD_FILES:
            raise SemanticError(400, "image_limit")
        parsed = []
        for raw_file in files:
            file = object_(raw_file)
            exact_keys(file, ["contentType", "size"])
            if type(file["size"]) is not int or file["size"] <= 0:
                raise ValueError("Invalid size")
            if not isinstance(file["contentType"], str):
                raise ValueError("Invalid content type")
            if file["size"] > MAX_IMAGE_BYTES:
                raise SemanticError(413, "image_too_large")
            if file["contentType"] not in IMAGE_TYPES:
                raise SemanticError(415, "image_unsupported")
            parsed.append(dict(file))
        if sum(file["size"] for file in parsed) > MAX_TOTAL_IMAGE_BYTES:
            raise SemanticError(400, "image_limit")
        return parsed
    except (ValueError, TypeError):
        raise SemanticError(400, "invalid_request") from None


async def issue_upload_urls(store: ImageStore, user_id: str, files: list[JSON]) -> JSON:
    async def issue(file: JSON) -> JSON:
        content_type = file["contentType"]
        path = f"uploads/{user_id}/{uuid4()}.{IMAGE_TYPES[content_type]}"
        check_owned_path(user_id, path)
        return {"path": path, **await store.signed_upload_url(path, content_type)}

    return {"uploads": list(await asyncio.gather(*(issue(file) for file in files)))}


async def read_verified_metadata(
    store: ImageStore, user_id: str, paths: list[str]
) -> list[ImageMetadata]:
    # Validate the entire list before starting any remote operation.
    for path in paths:
        check_owned_path(user_id, path)
    if len(set(paths)) != len(paths):
        raise SemanticError(400, "invalid_request")
    items = await asyncio.gather(*(store.metadata(path) for path in paths))
    verified = []
    for item in items:
        if item is None:
            raise SemanticError(404, "image_not_found")
        if item.size <= 0 or item.size > MAX_IMAGE_BYTES:
            raise SemanticError(413, "image_too_large")
        verified.append(item)
    if sum(item.size for item in verified) > MAX_TOTAL_IMAGE_BYTES:
        raise SemanticError(400, "image_limit")
    if any(item.content_type not in IMAGE_TYPES for item in verified):
        raise SemanticError(415, "image_unsupported")
    return verified


async def download_verified(
    store: ImageStore, metadata_list: list[ImageMetadata]
) -> list[tuple[str, bytes]]:
    async def download(item: ImageMetadata) -> tuple[str, bytes]:
        data = await store.download(item.path, item.generation)
        if len(data) != item.size:
            raise SemanticError(409, "image_changed")
        matches = {
            "image/jpeg": data.startswith(b"\xff\xd8\xff"),
            "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/webp": len(data) >= 12
            and data[:4] == b"RIFF"
            and data[8:12] == b"WEBP",
        }
        if not matches.get(item.content_type, False):
            raise SemanticError(415, "image_unsupported")
        return item.content_type, data

    return list(await asyncio.gather(*(download(item) for item in metadata_list)))


class GcsImageStore:
    def __init__(self, bucket: str):
        self.bucket = bucket
        self._client: Any = None
        self._lock = Lock()

    def _blob(self, path: str) -> Any:
        with self._lock:
            if self._client is None:
                self._client = storage.Client()
        return self._client.bucket(self.bucket).blob(path)

    async def signed_upload_url(self, path: str, content_type: str) -> JSON:
        def sign() -> JSON:
            try:
                blob = self._blob(path)
                # Cloud Run ADC are service-account credentials; signing uses
                # IAM signBlob with the access token, so no key file is needed.
                credentials: Any
                credentials, _ = google.auth.default()
                credentials.refresh(Request())
                expiration = datetime.now(UTC) + UPLOAD_URL_TTL
                url = blob.generate_signed_url(
                    version="v4",
                    method="PUT",
                    content_type=content_type,
                    expiration=expiration,
                    service_account_email=credentials.service_account_email,
                    access_token=credentials.token,
                )
                return {
                    "url": url,
                    "expiresAt": expiration.isoformat().replace("+00:00", "Z"),
                    "requiredHeaders": {"Content-Type": content_type},
                }
            except Exception:
                raise SemanticError(502, "image_error") from None

        return await asyncio.to_thread(sign)

    async def metadata(self, path: str) -> ImageMetadata | None:
        def read() -> ImageMetadata | None:
            try:
                blob = self._blob(path)
                blob.reload()
                return ImageMetadata(
                    path, int(blob.size), blob.content_type, str(blob.generation)
                )
            except NotFound:
                return None
            except Exception:
                raise SemanticError(502, "image_error") from None

        return await asyncio.to_thread(read)

    async def download(self, path: str, generation: str) -> bytes:
        def read() -> bytes:
            try:
                data: bytes = self._blob(path).download_as_bytes(
                    if_generation_match=int(generation)
                )
                return data
            except PreconditionFailed:
                raise SemanticError(409, "image_changed") from None
            except NotFound:
                raise SemanticError(404, "image_not_found") from None
            except Exception:
                raise SemanticError(502, "image_error") from None

        return await asyncio.to_thread(read)
