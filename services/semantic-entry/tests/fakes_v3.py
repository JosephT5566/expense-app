from copy import deepcopy
from unittest.mock import AsyncMock, Mock

from conftest import CONTEXT, RAW, REQUEST_ID, ROW
from fakes_images import FakeImageStore

from semantic_entry.contracts import DRAFT_FIELDS
from semantic_entry.drafts import normalize_draft
from semantic_entry.graph import Dependencies

DRAFT_ID = "33333333-3333-4333-8333-333333333333"
PATH = "uploads/a/receipt.jpg"
IMAGE_REQUEST = {"requestId": REQUEST_ID, "action": "analyze", "images": [PATH]}


def raw_draft():
    values = {
        "note": "午餐",
        "amount": 851,
        "currency": "TWD",
        "date": CONTEXT["today"],
        "categoryId": CONTEXT["categories"][0]["id"],
        "scope": None,
        "payerEmail": None,
        "splitMemberEmails": None,
    }
    return {
        "draftId": DRAFT_ID,
        "originalAmountText": None,
        **{
            k: {
                "value": values[k],
                "state": "recognized" if values[k] is not None else "missing",
                "confidence": 0.9,
                "source": "image",
            }
            for k in DRAFT_FIELDS
        },
    }


def client_draft():
    return normalize_draft(raw_draft(), deepcopy(CONTEXT))


def make_setup():
    adapter = Mock()
    adapter.authenticate = AsyncMock(
        return_value={"id": "a", "email": "a@example.test"}
    )
    adapter.load_context = AsyncMock(return_value=deepcopy(CONTEXT))
    adapter.lookup_completed = AsyncMock(return_value=None)
    adapter.lookup_completed_v3 = AsyncMock(return_value=None)
    adapter.consume_quota = AsyncMock(return_value=True)
    adapter.persist_expense = AsyncMock(
        return_value={"expense": deepcopy(ROW), "replayed": False}
    )
    adapter.persist_expenses = AsyncMock(
        return_value={"expenses": [deepcopy(ROW)], "replayed": False}
    )
    store = FakeImageStore()
    store.add(PATH)
    extractor = AsyncMock(
        return_value={
            "raw": {"drafts": [raw_draft()], "nonReceiptImages": []},
            "model": "synthetic",
            "inputTokens": None,
            "outputTokens": None,
        }
    )
    text = AsyncMock(
        return_value={
            "raw": deepcopy(RAW),
            "model": "synthetic",
            "inputTokens": None,
            "outputTokens": None,
        }
    )
    deps = Dependencies(
        Mock(return_value=adapter),
        text,
        Mock(),
        image_store=store,
        extract_drafts=extractor,
    )
    return deps, adapter, store
