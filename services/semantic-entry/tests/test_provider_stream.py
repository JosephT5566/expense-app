import asyncio
import json

import httpx
import pytest
from conftest import CONTEXT, RAW

from semantic_entry.errors import SemanticError
from semantic_entry.provider import Provider
from semantic_entry.provider_stream import AnalysisDecoder, iter_sse_data


class Bytes(httpx.AsyncByteStream):
    def __init__(self, frames, pause=None):
        self.frames = frames
        self.pause = pause
        self.closed = False

    async def __aiter__(self):
        for frame in self.frames:
            yield frame
            if self.pause:
                await self.pause.wait()

    async def aclose(self):
        self.closed = True


def frame(text=None, finish=None, usage=None, thought=False):
    candidate = {}
    if text is not None:
        candidate["content"] = {"parts": [{"text": text, "thought": thought}]}
    if finish:
        candidate["finishReason"] = finish
    data = {"candidates": [candidate]}
    if usage:
        data["usageMetadata"] = usage
    return ("data: " + json.dumps(data) + "\r\n\r\n").encode()


@pytest.mark.parametrize("late", [False, True])
def test_decoder_handles_every_character_boundary(late):
    analysis = '午餐「麵」🍜\\"'
    obj = {"analysis": analysis, "extraction": {**RAW, "note": "nested analysis"}}
    if late:
        obj = {"extraction": obj["extraction"], "analysis": analysis}
    text = json.dumps(obj, ensure_ascii=True)
    decoder = AnalysisDecoder()
    received = "".join(decoder.feed(c) for c in text)
    assert received == analysis
    decoder.finish(analysis)


@pytest.mark.parametrize(
    "text",
    [
        '{"analysis":"\\uD800x"}',
        '{"analysis":"\\q"}',
        '{"analysis":"a","analysis":"b"}',
        '{"analysis":"' + "x" * 201,
        '{"extraction":{"analysis":"hidden"},"analysis":""}',
        " " * 65537,
    ],
)
def test_decoder_rejects_invalid_structure(text):
    with pytest.raises(ValueError):
        AnalysisDecoder().feed(text)


async def test_sse_handles_utf8_and_multiline_frames():
    async def chunks():
        for b in ':comment\r\ndata: {"text":\r\ndata: "午餐🍜"}\r\n\r\n'.encode():
            yield bytes([b])

    assert [data async for data in iter_sse_data(chunks())] == ['{"text":\n"午餐🍜"}']


async def test_stream_emits_before_final_and_counts_usage_once():
    ready = asyncio.Event()
    seen = []
    calls = []
    observed = asyncio.Event()
    text = json.dumps(
        {"analysis": "已辨識午餐。", "extraction": RAW}, ensure_ascii=False
    )
    cut = text.index(', "extraction"')
    usage = {
        "promptTokenCount": 100,
        "candidatesTokenCount": 40,
        "thoughtsTokenCount": 5,
    }

    class Controlled(Bytes):
        async def __aiter__(self):
            yield frame("private thought", thought=True)
            yield frame(text[:cut], usage=usage)
            await ready.wait()
            yield frame(text[cut:], "STOP", usage)

    stream = Controlled([])

    async def callback(delta):
        seen.append(delta)
        observed.set()

    def mock(request):
        calls.append(request)
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
        task = asyncio.create_task(
            Provider(client, "synthetic").stream("午餐851", CONTEXT, callback)
        )
        await asyncio.wait_for(observed.wait(), 1)
        assert not task.done()
        assert "".join(seen) == "已辨識午餐。"
        ready.set()
        result = await task
    assert "".join(seen) == "已辨識午餐。"
    assert result["raw"] == RAW and result["outputTokens"] == 45
    assert len(calls) == 1 and calls[0].url.params["alt"] == "sse"
    assert calls[0].url.path.endswith(":streamGenerateContent")
    assert calls[0].headers["x-goog-api-key"] == "synthetic" and stream.closed


@pytest.mark.parametrize("finish", [None, "MAX_TOKENS", "SAFETY"])
async def test_stream_partial_then_invalid_never_returns_extraction(finish):
    text = json.dumps({"analysis": "午餐", "extraction": RAW})
    stream = Bytes([frame(text, finish)])
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic").stream(
                "test", CONTEXT, lambda delta: asyncio.sleep(0)
            )
    assert exc.value.code in ("provider_invalid", "provider_refusal") and stream.closed


async def test_stream_deadline_is_total_and_closes_upstream():
    async def callback(delta):
        await asyncio.sleep(0.02)

    stream = Bytes([frame('{"analysis":"a'), frame("b"), frame("c")])
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic", deadline=0.01).stream(
                "test", CONTEXT, callback
            )
    assert exc.value.code == "provider_timeout" and stream.closed


async def test_cancel_closes_upstream():
    waiting = asyncio.Event()
    entered = asyncio.Event()
    stream = Bytes([frame('{"analysis":"午餐')], waiting)

    async def callback(delta):
        entered.set()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as client:
        task = asyncio.create_task(
            Provider(client, "synthetic").stream("test", CONTEXT, callback)
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert stream.closed


@pytest.mark.parametrize(
    "payload",
    [
        b"data: \xff\n\n",
        b"data: " + b"x" * 65536 + b"\n\n",
        b"data: {}",
        frame('{"analysis":"a","analysis":"b","extraction":{}}', "STOP"),
        frame('{"analysis":"' + "x" * 201, "STOP"),
    ],
)
async def test_bad_frames_are_bounded_and_rejected(payload):
    stream = Bytes([payload])
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as client:
        with pytest.raises(SemanticError) as exc:
            await Provider(client, "synthetic").stream(
                "test", CONTEXT, lambda delta: asyncio.sleep(0)
            )
    assert exc.value.code == "provider_invalid" and stream.closed
