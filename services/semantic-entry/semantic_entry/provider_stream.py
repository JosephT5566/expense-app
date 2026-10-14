"""Bounded upstream SSE framing and incremental top-level analysis decoding."""

import codecs
import json
from collections.abc import AsyncIterator, Awaitable, Callable

AnalysisCallback = Callable[[str], Awaitable[None]]
LIMIT = 65536


async def iter_sse_data(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    buffer = ""
    data: list[str] = []
    size = 0
    async for chunk in chunks:
        buffer += decoder.decode(chunk)
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            size += len(line.encode("utf-8")) + 1
            if size > LIMIT:
                raise ValueError("SSE frame too large")
            line = line.removesuffix("\r")
            if not line:
                if data:
                    yield "\n".join(data)
                data = []
                size = 0
            elif line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
        if size + len(buffer.encode("utf-8")) > LIMIT:
            raise ValueError("SSE frame too large")
    buffer += decoder.decode(b"", final=True)
    if buffer or data:
        raise ValueError("Incomplete SSE frame")


class AnalysisDecoder:
    """Walk a strict envelope; only the analysis string can emit partial data."""

    def __init__(self) -> None:
        self.buffer = ""
        self.pos = 0
        self.state = "start"
        self.key = ""
        self.keys: set[str] = set()
        self.analysis = ""
        self.high: int | None = None

    def feed(self, fragment: str) -> str:
        self.buffer += fragment
        if len(self.buffer.encode("utf-8")) > LIMIT:
            raise ValueError("Model text too large")
        emitted = ""
        while self.pos < len(self.buffer):
            char = self.buffer[self.pos]
            if self.state != "analysis" and char in " \r\n\t":
                self.pos += 1
                continue
            if self.state == "analysis":
                if char == '"':
                    if self.high is not None or not self.analysis.strip():
                        raise ValueError("Invalid analysis")
                    self.pos += 1
                    self.state = "after"
                    continue
                if char == "\\":
                    if self.pos + 1 >= len(self.buffer):
                        break
                    escape = self.buffer[self.pos + 1]
                    width = 6 if escape == "u" else 2
                    if self.pos + width > len(self.buffer):
                        break
                    char = json.loads(
                        '"' + self.buffer[self.pos : self.pos + width] + '"'
                    )
                else:
                    width = 1
                    if ord(char) < 32:
                        raise ValueError("Invalid string character")
                code = ord(char)
                if self.high is not None:
                    if not 0xDC00 <= code <= 0xDFFF:
                        raise ValueError("Invalid surrogate pair")
                    char = chr(0x10000 + ((self.high - 0xD800) << 10) + code - 0xDC00)
                    self.high = None
                elif 0xD800 <= code <= 0xDBFF:
                    self.high = code
                    self.pos += width
                    continue
                elif 0xDC00 <= code <= 0xDFFF:
                    raise ValueError("Unpaired surrogate")
                self.analysis += char
                if len(self.analysis) > 200:
                    raise ValueError("Analysis too large")
                emitted += char
                self.pos += width
            elif self.state == "start":
                if char != "{":
                    raise ValueError("Expected envelope object")
                self.pos += 1
                self.state = "key"
            elif self.state == "key":
                if char != '"':
                    raise ValueError("Expected envelope key")
                try:
                    key, end = json.JSONDecoder().raw_decode(self.buffer, self.pos)
                except json.JSONDecodeError:
                    break
                if key not in ("analysis", "extraction") or key in self.keys:
                    raise ValueError("Invalid envelope key")
                self.key = key
                self.keys.add(key)
                self.pos = end
                self.state = "colon"
            elif self.state == "colon":
                if char != ":":
                    raise ValueError("Expected colon")
                self.pos += 1
                self.state = "value"
            elif self.state == "value":
                if self.key == "analysis":
                    if char != '"':
                        raise ValueError("Expected analysis string")
                    self.pos += 1
                    self.state = "analysis"
                else:
                    if char != "{":
                        raise ValueError("Expected extraction object")
                    try:
                        _, end = json.JSONDecoder().raw_decode(self.buffer, self.pos)
                    except json.JSONDecodeError:
                        break
                    self.pos = end
                    self.state = "after"
            elif self.state == "after":
                if char == ",":
                    self.state = "key"
                elif char == "}" and self.keys == {"analysis", "extraction"}:
                    self.state = "done"
                else:
                    raise ValueError("Invalid envelope separator")
                self.pos += 1
            else:
                raise ValueError("Trailing model text")
        return emitted

    def finish(self, analysis: str) -> None:
        if self.state != "done" or self.high is not None or self.analysis != analysis:
            raise ValueError("Incomplete or inconsistent analysis")
