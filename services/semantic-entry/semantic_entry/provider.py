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

    async def __call__(self, text: str, context: JSON) -> JSON:
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
        try:
            async with asyncio.timeout(self.deadline):
                response = await self.client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
                    headers={"x-goog-api-key": self.api_key},
                    json={
                        "systemInstruction": {
                            "parts": [{"text": system_prompt(context)}]
                        },
                        "contents": [{"role": "user", "parts": [{"text": text}]}],
                        "generationConfig": {
                            "candidateCount": 1,
                            "maxOutputTokens": 800,
                            "thinkingConfig": thinking,
                            "responseFormat": {
                                "text": {
                                    "mimeType": "application/json",
                                    "schema": PROVIDER_SCHEMA,
                                }
                            },
                        },
                    },
                )
                if not response.is_success:
                    raise SemanticError(502, "provider_error")
                try:
                    data = load_json(response.content)
                    if data.get("promptFeedback", {}).get("blockReason"):
                        raise SemanticError(502, "provider_refusal")
                    candidates = data.get("candidates")
                    if not isinstance(candidates, list) or len(candidates) != 1:
                        raise ValueError("Invalid candidates")
                    candidate = candidates[0]
                    if candidate.get("finishReason") in BLOCKED:
                        raise SemanticError(502, "provider_refusal")
                    if candidate.get("finishReason") != "STOP":
                        raise ValueError("Incomplete output")
                    parts = candidate["content"]["parts"]
                    if not isinstance(parts, list) or not parts:
                        raise ValueError("Invalid parts")
                    texts = []
                    for part in parts:
                        if part.get("thought") is True:
                            continue
                        if not isinstance(part.get("text"), str) or not set(part) <= {
                            "text",
                            "thought",
                            "thoughtSignature",
                        }:
                            raise ValueError("Invalid output part")
                        texts.append(part["text"])
                    if not texts:
                        raise ValueError("Missing output text")
                    raw = parse_provider_envelope(load_provider_json("".join(texts)))[
                        "extraction"
                    ]
                    usage = data.get("usageMetadata") or {}
                    output = usage.get("candidatesTokenCount")
                    thoughts = usage.get("thoughtsTokenCount", 0)
                    output_tokens = (
                        output + thoughts
                        if safe_integer(output)
                        and safe_integer(thoughts)
                        and safe_integer(output + thoughts)
                        else None
                    )
                    return {
                        "raw": raw,
                        "model": self.model,
                        "inputTokens": usage.get("promptTokenCount")
                        if safe_integer(usage.get("promptTokenCount"))
                        else None,
                        "outputTokens": output_tokens,
                    }
                except (ValueError, TypeError, AttributeError, KeyError):
                    raise SemanticError(502, "provider_invalid") from None
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticError(504, "provider_timeout") from None
        except httpx.HTTPError:
            raise SemanticError(502, "provider_error") from None
