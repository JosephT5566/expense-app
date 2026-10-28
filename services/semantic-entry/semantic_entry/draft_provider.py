"""Lazy, bounded Google GenAI adapter for untrusted receipt extractions."""

import asyncio
import json
from typing import Any

import httpx
from google import genai
from google.genai import errors, types

from .contracts import JSON, load_provider_json, safe_integer
from .drafts import parse_raw_extraction
from .errors import SemanticError
from .prompt import RECEIPT_SCHEMA, receipt_system_prompt
from .provider import DEFAULT_MODEL, MODEL, Provider


class DraftProvider:
    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        *,
        client: Any = None,
        image_deadline: float = 75,
        revise_deadline: float = 25,
    ):
        self.api_key = api_key
        self.model = model
        self.client = client
        self.image_deadline = image_deadline
        self.revise_deadline = revise_deadline

    async def __call__(self, input: JSON, context: JSON) -> JSON:
        if not self.api_key or not MODEL.fullmatch(self.model):
            raise SemanticError(502, "provider_configuration")
        revise = input["mode"] == "revise"
        deadline = self.revise_deadline if revise else self.image_deadline
        # Image bytes never enter JSON or diagnostics. Revise never forwards images.
        images = [] if revise else input.get("images", [])
        data = {
            key: input.get(key, default)
            for key, default in (("text", ""), ("history", []), ("drafts", []))
        }
        parts = [
            types.Part.from_text(
                text=json.dumps(
                    data, ensure_ascii=False, separators=(",", ":"), allow_nan=False
                )
            )
        ]
        parts.extend(
            types.Part.from_bytes(data=i["data"], mime_type=i["mimeType"])
            for i in images
        )
        thinking = (
            types.ThinkingConfig(thinking_budget=0)
            if self.model.startswith("gemini-2.5-")
            else types.ThinkingConfig(
                thinking_level=types.ThinkingLevel.LOW
                if self.model == "gemini-3.8-flash"
                else types.ThinkingLevel.MINIMAL
            )
        )
        config = types.GenerateContentConfig(
            max_output_tokens=4096,
            candidate_count=1,
            response_mime_type="application/json",
            response_json_schema=RECEIPT_SCHEMA,
            system_instruction=receipt_system_prompt(context, input["mode"]),
            thinking_config=thinking,
            http_options=types.HttpOptions(
                retry_options=types.HttpRetryOptions(attempts=1)
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        )
        try:
            async with asyncio.timeout(deadline):
                if self.client is None:
                    self.client = genai.Client(api_key=self.api_key)
                response = await self.client.aio.models.generate_content(
                    model=self.model,
                    contents=[types.Content(role="user", parts=parts)],
                    config=config,
                )
                envelope = response.model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
                candidate = Provider.candidate(envelope)
                if not candidate or candidate.get("finishReason") != "STOP":
                    raise ValueError("Incomplete output")
                raw = parse_raw_extraction(
                    load_provider_json(Provider.text(candidate)), len(images)
                )
                usage = envelope.get("usageMetadata") or {}
                output = usage.get("candidatesTokenCount")
                thoughts = usage.get("thoughtsTokenCount", 0)
                return {
                    "raw": raw,
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
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticError(504, "provider_timeout") from None
        except errors.APIError as error:
            diagnostics = (
                {"upstreamHttpStatus": error.code} if type(error.code) is int else {}
            )
            raise SemanticError(
                502, "provider_error", diagnostics=diagnostics
            ) from None
        except httpx.HTTPError:
            raise SemanticError(502, "provider_error") from None
        except (ValueError, TypeError, AttributeError, KeyError, UnicodeError):
            raise SemanticError(502, "provider_invalid") from None
