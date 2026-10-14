"""Gemini Developer API adapter, with bounded single-call extraction."""

import asyncio
import re

import httpx

from .contracts import (
    JSON,
    load_json,
    load_provider_json,
    parse_provider_envelope,
    safe_integer,
)
from .errors import SemanticError
from .prompt import PROVIDER_SCHEMA, system_prompt
from .provider_stream import AnalysisCallback, AnalysisDecoder, iter_sse_data

DEFAULT_MODEL = "gemini-3.5-flash-lite"
MODEL = re.compile(
    r"gemini-(?:2\.5-flash(?:-lite)?|3\.5-flash-lite|3\.6-flash|3\.8-flash)"
)
BLOCKED = {
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
}


class Provider:
    def __init__(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        model: str = DEFAULT_MODEL,
        deadline: float = 15,
    ):
        self.client = client
        self.api_key = api_key
        self.model = model
        self.deadline = deadline

    def request_body(self, text: str, context: JSON) -> JSON:
        if not self.api_key or not MODEL.fullmatch(self.model):
            raise SemanticError(502, "provider_configuration")
        thinking = (
            {"thinkingBudget": 0}
            if self.model.startswith("gemini-2.5-")
            else {
                "thinkingLevel": "LOW"
                if self.model == "gemini-3.8-flash"
                else "MINIMAL"
            }
        )
        return {
            "systemInstruction": {"parts": [{"text": system_prompt(context)}]},
            "contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {
                "candidateCount": 1,
                "maxOutputTokens": 800,
                "thinkingConfig": thinking,
                "responseFormat": {
                    "text": {"mimeType": "application/json", "schema": PROVIDER_SCHEMA}
                },
            },
        }

    def result(self, envelope: JSON, usage: JSON) -> JSON:
        output = usage.get("candidatesTokenCount")
        thoughts = usage.get("thoughtsTokenCount", 0)
        return {
            "raw": envelope["extraction"],
            "model": self.model,
            "inputTokens": usage.get("promptTokenCount")
            if safe_integer(usage.get("promptTokenCount"))
            else None,
            "outputTokens": output + thoughts
            if safe_integer(output)
            and safe_integer(thoughts)
            and safe_integer(output + thoughts)
            else None,
        }

    @staticmethod
    def candidate(data: JSON) -> JSON | None:
        if data.get("promptFeedback", {}).get("blockReason"):
            raise SemanticError(502, "provider_refusal")
        candidates = data.get("candidates")
        if candidates is None or candidates == []:
            if "usageMetadata" in data:
                return None
            raise ValueError("Missing candidates")
        if (
            not isinstance(candidates, list)
            or len(candidates) != 1
            or not isinstance(candidates[0], dict)
        ):
            raise ValueError("Invalid candidates")
        candidate = candidates[0]
        if candidate.get("finishReason") in BLOCKED:
            raise SemanticError(502, "provider_refusal")
        if candidate.get("finishReason") not in (None, "STOP"):
            raise ValueError("Incomplete output")
        return candidate

    @staticmethod
    def text(candidate: JSON) -> str:
        parts = candidate.get("content", {}).get("parts", [])
        if not isinstance(parts, list):
            raise ValueError("Invalid parts")
        texts = []
        for part in parts:
            if not isinstance(part, dict):
                raise ValueError("Invalid part")
            if part.get("thought") is True:
                continue
            if not isinstance(part.get("text"), str) or not set(part) <= {
                "text",
                "thought",
                "thoughtSignature",
            }:
                raise ValueError("Invalid output part")
            texts.append(part["text"])
        return "".join(texts)

    async def __call__(self, text: str, context: JSON) -> JSON:
        body = self.request_body(text, context)
        try:
            async with asyncio.timeout(self.deadline):
                response = await self.client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
                    headers={"x-goog-api-key": self.api_key},
                    json=body,
                )
                if not response.is_success:
                    raise SemanticError(502, "provider_error")
                data = load_json(response.content)
                candidate = self.candidate(data)
                if not candidate or candidate.get("finishReason") != "STOP":
                    raise ValueError("Incomplete output")
                envelope = parse_provider_envelope(
                    load_provider_json(self.text(candidate))
                )
                return self.result(envelope, data.get("usageMetadata") or {})
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticError(504, "provider_timeout") from None
        except httpx.HTTPError:
            raise SemanticError(502, "provider_error") from None
        except (ValueError, TypeError, AttributeError, KeyError, UnicodeError):
            raise SemanticError(502, "provider_invalid") from None

    async def stream(
        self, text: str, context: JSON, on_analysis: AnalysisCallback
    ) -> JSON:
        body = self.request_body(text, context)
        decoder = AnalysisDecoder()
        usage: JSON = {}
        finished = False
        try:
            async with asyncio.timeout(self.deadline):
                async with self.client.stream(
                    "POST",
                    f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:streamGenerateContent",
                    params={"alt": "sse"},
                    headers={"x-goog-api-key": self.api_key},
                    json=body,
                ) as response:
                    if not response.is_success:
                        raise SemanticError(502, "provider_error")
                    async for payload in iter_sse_data(response.aiter_bytes()):
                        data = load_provider_json(payload)
                        candidate = self.candidate(data)
                        if "usageMetadata" in data:
                            usage = data["usageMetadata"] or {}
                        if candidate is None:
                            continue
                        if finished:
                            raise ValueError("Candidate after completion")
                        delta = decoder.feed(self.text(candidate))
                        if delta:
                            await on_analysis(delta)
                        finished = candidate.get("finishReason") == "STOP"
                if not finished:
                    raise ValueError("Missing completion")
                envelope = parse_provider_envelope(load_provider_json(decoder.buffer))
                decoder.finish(envelope["analysis"])
                return self.result(envelope, usage)
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticError(504, "provider_timeout") from None
        except httpx.HTTPError:
            raise SemanticError(502, "provider_error") from None
        except (ValueError, TypeError, AttributeError, KeyError, UnicodeError):
            raise SemanticError(502, "provider_invalid") from None
