import asyncio

import httpx

from .contracts import JSON, load_json, safe_integer
from .errors import SemanticError
from .normalize import parse_extraction
from .prompt import EXTRACTION_SCHEMA, system_prompt


class Provider:
    def __init__(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        model: str = "gpt-5.4-mini",
        deadline: float = 15,
    ):
        self.client = client
        self.api_key = api_key
        self.model = model
        self.deadline = deadline

    async def __call__(self, text: str, context: JSON) -> JSON:
        if not self.api_key:
            raise SemanticError(502, "provider_configuration")
        try:
            async with asyncio.timeout(self.deadline):
                response = await self.client.post(
                    "https://api.openai.com/v1/responses",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "store": False,
                        "max_output_tokens": 800,
                        "reasoning": {"effort": "none"},
                        "input": [
                            {"role": "system", "content": system_prompt(context)},
                            {"role": "user", "content": text},
                        ],
                        "text": {
                            "format": {
                                "type": "json_schema",
                                "name": "semantic_expense",
                                "strict": True,
                                "schema": EXTRACTION_SCHEMA,
                            }
                        },
                    },
                )
                if not response.is_success:
                    raise SemanticError(502, "provider_error")
                try:
                    data = load_json(response.content)
                    if data.get("status") != "completed" or not isinstance(
                        data.get("output"), list
                    ):
                        raise ValueError("Invalid output")
                    content = [
                        c for item in data["output"] for c in item.get("content", [])
                    ]
                    if any(c.get("type") == "refusal" for c in content):
                        raise SemanticError(502, "provider_refusal")
                    texts = [c for c in content if c.get("type") == "output_text"]
                    if len(texts) != 1 or not isinstance(texts[0].get("text"), str):
                        raise ValueError("Invalid output text")
                    raw = parse_extraction(load_json(texts[0]["text"]))
                    usage = data.get("usage") or {}
                    return {
                        "raw": raw,
                        "model": self.model,
                        "inputTokens": usage.get("input_tokens")
                        if safe_integer(usage.get("input_tokens"))
                        else None,
                        "outputTokens": usage.get("output_tokens")
                        if safe_integer(usage.get("output_tokens"))
                        else None,
                    }
                except (ValueError, TypeError, AttributeError, KeyError):
                    raise SemanticError(502, "provider_invalid") from None
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticError(504, "provider_timeout") from None
        except httpx.HTTPError:
            raise SemanticError(502, "provider_error") from None
