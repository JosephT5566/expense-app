"""Emit synthetic Python contract cases for the browser's TypeScript validators."""

import asyncio
import json
from copy import deepcopy
from unittest.mock import Mock

import httpx
from conftest import CONTEXT, RAW, REQUEST, REQUEST_ID, ROW

from semantic_entry.contracts import parse_request
from semantic_entry.graph import Dependencies, input_hash
from semantic_entry.server import create_app


class Adapter:
    saved = None

    async def authenticate(self):
        return {"id": "a", "email": "a@example.test"}

    async def load_context(self, user):
        return CONTEXT

    async def lookup_completed(self, request_id, input_hash=None):
        return self.saved

    async def consume_quota(self):
        return True

    async def persist_expense(self, request_id, input_hash, expense):
        return {"expense": ROW, "replayed": False}


async def main():
    inputs = [
        REQUEST,
        {**REQUEST, "history": []},
        {**REQUEST, "history": [{"question": " 金額？ ", "answer": " e\u0301 "}]},
        {**REQUEST, "history": [{"question": "金額？", "answer": "100"}]},
        {**REQUEST, "history": None},
        {
            **REQUEST,
            "history": [{"question": "金額？", "answer": "100", "userId": "a"}],
        },
        {**REQUEST, "history": [{"question": "q", "answer": "a"}] * 4},
        {**REQUEST, "text": " " + "🍜" * 500 + " "},
        {**REQUEST, "text": "e\u0301"},
        {**REQUEST, "text": "\ufeff 午餐851 \ufeff"},
        {**REQUEST, "text": "🍜" * 501},
        {**REQUEST, "text": "e\u0301" * 250 + "x"},
        {**REQUEST, "text": " "},
        {**REQUEST, "requestId": "bad"},
        {**REQUEST, "userId": "a"},
        {**REQUEST, "hash": "x"},
    ]
    requests = []
    for raw in inputs:
        try:
            parsed = parse_request(raw)
            requests.append({"raw": raw, "parsed": parsed, "hash": input_hash(parsed)})
        except ValueError:
            requests.append({"raw": raw, "invalid": True})
    adapter = Adapter()
    extraction = {
        "raw": deepcopy(RAW),
        "model": "synthetic",
        "inputTokens": None,
        "outputTokens": None,
    }

    async def extract(text, context):
        return extraction

    async def stream_extract(text, context, callback):
        await callback("辨識午餐🍜")
        return extraction

    deps = Dependencies(
        Mock(return_value=adapter), extract, stream_entry=stream_extract
    )
    responses = []
    streams = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://localhost"
    ) as client:
        headers = {"Authorization": "Bearer synthetic"}
        responses.append(
            {
                "kind": "response",
                "body": (
                    await client.post("/semantic-entry", headers=headers, json=REQUEST)
                ).json(),
            }
        )
        extraction["raw"]["amount"] = None
        responses.append(
            {
                "kind": "response",
                "body": (
                    await client.post("/semantic-entry", headers=headers, json=REQUEST)
                ).json(),
            }
        )
        responses.append(
            {
                "kind": "status",
                "body": (
                    await client.get(f"/semantic-entry/{REQUEST_ID}", headers=headers)
                ).json(),
            }
        )
        for raw in (deepcopy(extraction["raw"]), deepcopy(RAW)):
            extraction["raw"] = raw
            stream = await client.post(
                "/semantic-entry",
                headers={**headers, "Accept": "text/event-stream"},
                json=REQUEST,
            )
            for frame in stream.text.strip().split("\n\n"):
                lines = frame.splitlines()
                streams.append(
                    {
                        "event": lines[0].removeprefix("event: "),
                        "body": json.loads(lines[1].removeprefix("data: ")),
                    }
                )
        extraction["raw"] = deepcopy(RAW)
        stream = await client.post(
            "/semantic-entry",
            headers={**headers, "Accept": "text/event-stream; semantic-version=2"},
            json=REQUEST,
        )
        for frame in stream.text.strip().split("\n\n"):
            lines = frame.splitlines()
            streams.append(
                {
                    "event": lines[0].removeprefix("event: "),
                    "body": json.loads(lines[1].removeprefix("data: ")),
                }
            )
        adapter.saved = {"expense": ROW, "replayed": True}
        responses.append(
            {
                "kind": "status",
                "body": (
                    await client.get(f"/semantic-entry/{REQUEST_ID}", headers=headers)
                ).json(),
            }
        )
        responses.append(
            {
                "kind": "response",
                "body": (
                    await client.post("/semantic-entry", headers=headers, json=REQUEST)
                ).json(),
            }
        )
    print(
        json.dumps(
            {"requests": requests, "responses": responses, "streams": streams},
            ensure_ascii=False,
        )
    )


asyncio.run(main())
