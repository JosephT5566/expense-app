"""Synthetic dependencies exercise container HTTP + graph, without model/DB calls."""

import uvicorn

from semantic_entry.graph import Dependencies
from semantic_entry.server import create_app

CONTEXT = {
    "today": "2026-03-01",
    "currentUserEmail": "a@example.test",
    "members": [{"id": "a", "email": "a@example.test", "name": "Synthetic"}],
    "categories": [{"id": "other", "name": "其他"}],
    "otherCategoryId": "other",
}
ROW = {
    "id": "22222222-2222-4222-8222-222222222222",
    "note": "synthetic lunch",
    "amount": 100,
    "currency": "TWD",
    "payer_email": "a@example.test",
    "scope": "personal",
    "shares_json": {"a@example.test": 100},
    "ts": "2026-02-28T16:00:00.000Z",
    "category_id": "other",
    "is_settled": True,
    "meta": "",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-01T00:00:00Z",
}


class Adapter:
    async def authenticate(self):
        return {"id": "a", "email": "a@example.test"}

    async def load_context(self, user):
        return CONTEXT

    async def lookup_completed(self, request_id, input_hash=None):
        return None

    async def consume_quota(self):
        return True

    async def persist_expense(self, request_id, input_hash, expense):
        return {"expense": ROW, "replayed": False}


async def extract(text, context):
    return {
        "raw": {
            "note": "synthetic lunch",
            "amount": 100,
            "currency": None,
            "date": {"kind": "missing", "value": None},
            "payerId": None,
            "scope": None,
            "hasSharedIntent": False,
            "splitMemberIds": None,
            "categoryId": None,
            "unsupportedReason": None,
        },
        "model": "synthetic",
        "inputTokens": None,
        "outputTokens": None,
    }


uvicorn.run(
    create_app(Dependencies(lambda token: Adapter(), extract)),
    host="0.0.0.0",
    port=8080,
    access_log=False,
)
