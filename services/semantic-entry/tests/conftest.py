from copy import deepcopy
from unittest.mock import AsyncMock, Mock

import pytest

from semantic_entry.graph import Dependencies

REQUEST_ID = "12345678-1234-4123-8123-123456789abc"
REQUEST = {"requestId": REQUEST_ID, "text": "午餐851"}
CONTEXT = {
    "today": "2026-03-01",
    "currentUserEmail": "a@example.test",
    "members": [
        {"id": "a", "email": "a@example.test", "name": "甲"},
        {"id": "b", "email": "b@example.test", "name": "乙"},
    ],
    "categories": [{"id": "11111111-1111-4111-8111-111111111111", "name": "其他"}],
    "otherCategoryId": "11111111-1111-4111-8111-111111111111",
}
RAW = {
    "note": "午餐",
    "amount": 851,
    "currency": None,
    "date": {"kind": "missing", "value": None},
    "payerId": None,
    "scope": None,
    "hasSharedIntent": False,
    "splitMemberIds": None,
    "categoryId": None,
    "unsupportedReason": None,
}
ROW = {
    "id": "22222222-2222-4222-8222-222222222222",
    "note": "午餐",
    "amount": 851,
    "currency": "TWD",
    "ts": "2026-02-28T16:00:00.000Z",
    "payer_email": "a@example.test",
    "scope": "personal",
    "shares_json": {"a@example.test": 851},
    "category_id": CONTEXT["otherCategoryId"],
    "is_settled": True,
    "meta": "",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-01T00:00:00Z",
}


@pytest.fixture
def setup():
    adapter = Mock()
    adapter.authenticate = AsyncMock(
        return_value={"id": "a", "email": "a@example.test"}
    )
    adapter.load_context = AsyncMock(return_value=deepcopy(CONTEXT))
    adapter.lookup_completed = AsyncMock(return_value=None)
    adapter.consume_quota = AsyncMock(return_value=True)
    adapter.persist_expense = AsyncMock(
        return_value={"expense": deepcopy(ROW), "replayed": False}
    )
    extract = AsyncMock(
        return_value={
            "raw": deepcopy(RAW),
            "model": "synthetic",
            "inputTokens": None,
            "outputTokens": None,
        }
    )
    log = Mock()
    return Dependencies(Mock(return_value=adapter), extract, log), adapter
