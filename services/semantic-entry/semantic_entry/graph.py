import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, TypedDict

from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context

from .clarification import clarification_result
from .contracts import JSON, parse_request
from .errors import SemanticError, error_details, log_failure
from .normalize import normalize_extraction
from .prompt import PROMPT_VERSION
from .provider_stream import AnalysisCallback


class Adapter(Protocol):
    async def authenticate(self) -> JSON: ...
    async def load_context(self, user: JSON) -> JSON: ...
    async def lookup_completed(
        self, request_id: str, input_hash: str | None = None
    ) -> JSON | None: ...
    async def consume_quota(self) -> bool: ...
    async def persist_expense(
        self, request_id: str, input_hash: str, expense: JSON
    ) -> JSON: ...


@dataclass
class Dependencies:
    create_adapter: Callable[[str], Adapter]
    extract_entry: Callable[[str, JSON], Awaitable[JSON]]
    log: Callable[[JSON], None] | None = None
    allowed_origins: tuple[str, ...] = ()
    http_deadline: float = 30
    stream_entry: Callable[[str, JSON, AnalysisCallback], Awaitable[JSON]] | None = None


class State(TypedDict, total=False):
    user: JSON
    context: JSON
    extraction: JSON
    validation: JSON
    result: JSON


def conversation_payload(request: JSON) -> str:
    return json.dumps(
        {"text": request["text"], "history": request.get("history", [])},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def input_hash(request: JSON | str) -> str:
    # Preserve legacy completed requests and snapshots; history hashes cover every correction.
    if isinstance(request, str):
        content = f"v1\n{request}"
    elif "referenceDate" in request:
        payload = {
            "text": request["text"],
            "history": request.get("history", []),
            "referenceDate": request["referenceDate"],
        }
        content = "v3\n" + json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        )
    elif not request.get("history"):
        content = f"v1\n{request['text']}"
    else:
        content = f"v2\n{conversation_payload(request)}"
    return hashlib.sha256(content.encode()).hexdigest()


def input_hash_v4_json(value: object) -> str:
    """Compact JSON with ECMAScript number spelling (notably 1.0 and exponents)."""
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + input_hash_v4_json(v)
                for k, v in value.items()
            )
            + "}"
        )
    if isinstance(value, list):
        return "[" + ",".join(input_hash_v4_json(v) for v in value) + "]"
    if isinstance(value, float):
        if not (-float("inf") < value < float("inf")):
            raise ValueError("Invalid hash number")
        if value == 0:
            return "0"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        text = repr(value)
        if "e" in text:
            coefficient, exponent = text.split("e")
            power = int(exponent)
            if -6 <= power < 21:
                from decimal import Decimal

                return format(Decimal(text), "f")
            return (
                coefficient.removesuffix(".0")
                + "e"
                + ("+" if power >= 0 else "-")
                + str(abs(power))
            )
        return text
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def input_hash_v4(request: JSON, images: list[JSON] | None = None) -> str:
    """V3 parsed input plus service-read generations; never wire-supplied generations.

    No graph routing changes: callers must explicitly opt in after reading metadata.
    Draft identity/merge provenance and all editable field metadata participate.
    Service-derived status/issues/updated do not participate.
    """
    from .contracts import exact_keys, parse_request_v3, string

    parsed = parse_request_v3(request)
    if "images" not in parsed and "drafts" not in parsed:
        if images:
            raise ValueError("Unexpected image metadata")
        return input_hash(parsed)
    resolved = []
    if "images" in parsed:
        if images is None or len(images) != len(parsed["images"]):
            raise ValueError("Missing image metadata")
        for path, image in zip(parsed["images"], images, strict=True):
            exact_keys(image, ["path", "generation"])
            if image["path"] != path:
                raise ValueError("Image path mismatch")
            resolved.append({"path": path, "generation": string(image["generation"])})
    elif images:
        raise ValueError("Unexpected image metadata")
    payload = {
        "action": parsed["action"],
        "text": parsed.get("text", ""),
        "history": parsed.get("history", []),
        "referenceDate": parsed.get("referenceDate"),
        "images": resolved,
        "drafts": parsed.get("drafts", []),
    }
    content = "v4\n" + input_hash_v4_json(payload)
    return hashlib.sha256(content.encode()).hexdigest()


async def invoke(
    request: JSON,
    token: str,
    deps: Dependencies,
    on_persisting: Callable[[JSON], Awaitable[None]] | None = None,
    on_analysis: AnalysisCallback | None = None,
) -> JSON:
    request = parse_request(request)
    start = time.monotonic()
    try:
        adapter = deps.create_adapter(token)
    except Exception as error:
        log_failure(
            deps.log,
            "initialize",
            error,
            request["requestId"],
            int((time.monotonic() - start) * 1000),
        )
        raise
    digest = input_hash(request)
    active_node = "authenticate"

    def elapsed() -> int:
        return int((time.monotonic() - start) * 1000)

    def log(node: str, status: str, details: JSON | None = None) -> None:
        try:
            if deps.log:
                deps.log(
                    {
                        "requestId": request["requestId"],
                        "node": node,
                        "status": status,
                        "elapsedMs": elapsed(),
                        **(details or {}),
                    }
                )
        except Exception:
            pass  # Logging must not change accepted writes.

    def metadata(extraction: JSON | None = None) -> JSON:
        e = extraction or {}
        return {
            "model": e.get("model", "replay"),
            "promptVersion": PROMPT_VERSION,
            "inputTokens": e.get("inputTokens"),
            "outputTokens": e.get("outputTokens"),
            "elapsedMs": elapsed(),
        }

    async def authenticate(state: State) -> JSON:
        nonlocal active_node
        active_node = "authenticate"
        user = await adapter.authenticate()
        log("authenticate", "ok")
        return {"user": user}

    async def load_context(state: State) -> JSON:
        nonlocal active_node
        active_node = "load_context"
        context = await adapter.load_context(state["user"])
        return {
            "context": {
                **context,
                "referenceDate": request.get("referenceDate", context["today"]),
            }
        }

    async def lookup(state: State) -> JSON:
        nonlocal active_node
        active_node = "lookup"
        saved = await adapter.lookup_completed(request["requestId"], digest)
        return (
            {
                "result": {
                    "status": "created",
                    "requestId": request["requestId"],
                    **saved,
                    "metadata": metadata(),
                }
            }
            if saved
            else {}
        )

    async def quota(state: State) -> JSON:
        nonlocal active_node
        active_node = "quota"
        if state["context"]["referenceDate"] > state["context"]["today"]:
            raise SemanticError(400, "invalid_request")
        if not await adapter.consume_quota():
            raise SemanticError(429, "quota_exceeded")
        return {}

    async def extract(state: State) -> JSON:
        nonlocal active_node
        active_node = "extract"
        text = (
            conversation_payload(request) if request.get("history") else request["text"]
        )
        if on_analysis is not None and deps.stream_entry is not None:
            return {
                "extraction": await deps.stream_entry(
                    text, state["context"], on_analysis
                )
            }
        return {
            "extraction": await deps.extract_entry(
                text,
                state["context"],
            )
        }

    def validate(state: State) -> JSON:
        nonlocal active_node
        active_node = "validate"
        validation = normalize_extraction(state["extraction"]["raw"], state["context"])
        result = {"validation": validation}
        if validation["status"] == "rejected":
            result["result"] = clarification_result(
                validation, request, state["context"]
            )
        return result

    async def persist(state: State) -> JSON:
        nonlocal active_node
        active_node = "persist"
        if state["validation"]["status"] != "valid":
            raise SemanticError(502, "invalid_graph_state")
        if on_persisting:
            await on_persisting(
                {"status": "persisting", "requestId": request["requestId"]}
            )
        try:
            completed = await adapter.persist_expense(
                request["requestId"], digest, state["validation"]["expense"]
            )
        except SemanticError as e:
            if not e.uncertain:
                raise
            raise SemanticError(
                504, "persist_uncertain", True, diagnostics=e.diagnostics
            ) from None
        except Exception as e:
            raise SemanticError(
                504,
                "persist_uncertain",
                True,
                diagnostics={"exceptionType": type(e).__name__},
            ) from None
        return {
            "result": {
                "status": "created",
                "requestId": request["requestId"],
                **completed,
                "metadata": metadata(state["extraction"]),
            }
        }

    def emit(state: State) -> JSON:
        nonlocal active_node
        active_node = "emit"
        log("emit_result", state["result"]["status"])
        return {}

    graph = StateGraph(State)
    graph.add_node("authenticate", authenticate)
    graph.add_node("load_context", load_context)
    graph.add_node("lookup", lookup)
    graph.add_node("quota", quota)
    graph.add_node("extract", extract)
    graph.add_node("validate", validate)
    graph.add_node("persist", persist)
    graph.add_node("emit_result", emit)
    for source, target in [
        (START, "authenticate"),
        ("authenticate", "load_context"),
        ("load_context", "lookup"),
        ("quota", "extract"),
        ("extract", "validate"),
        ("persist", "emit_result"),
        ("emit_result", END),
    ]:
        graph.add_edge(source, target)
    graph.add_conditional_edges(
        "lookup", lambda state: "emit_result" if state.get("result") else "quota"
    )
    graph.add_conditional_edges(
        "validate",
        lambda state: (
            "persist" if state["validation"]["status"] == "valid" else "emit_result"
        ),
    )
    # No checkpointer, state persistence, tools or externally enabled payload tracing.
    try:
        with tracing_context(enabled=False):
            final = await graph.compile().ainvoke({}, config={"callbacks": []})
        return final["result"]
    except Exception as error:
        log(active_node, "error", error_details(error))
        raise
