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
from .errors import SemanticError
from .normalize import normalize_extraction
from .prompt import PROMPT_VERSION


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
    elif not request.get("history"):
        content = f"v1\n{request['text']}"
    else:
        content = f"v2\n{conversation_payload(request)}"
    return hashlib.sha256(content.encode()).hexdigest()


async def invoke(
    request: JSON,
    token: str,
    deps: Dependencies,
    on_persisting: Callable[[JSON], Awaitable[None]] | None = None,
) -> JSON:
    request = parse_request(request)
    adapter = deps.create_adapter(token)
    start = time.monotonic()
    digest = input_hash(request)

    def elapsed() -> int:
        return int((time.monotonic() - start) * 1000)

    def log(node: str, status: str) -> None:
        try:
            if deps.log:
                deps.log(
                    {
                        "requestId": request["requestId"],
                        "node": node,
                        "status": status,
                        "elapsedMs": elapsed(),
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
        user = await adapter.authenticate()
        log("authenticate", "ok")
        return {"user": user}

    async def load_context(state: State) -> JSON:
        return {"context": await adapter.load_context(state["user"])}

    async def lookup(state: State) -> JSON:
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
        if not await adapter.consume_quota():
            raise SemanticError(429, "quota_exceeded")
        return {}

    async def extract(state: State) -> JSON:
        return {
            "extraction": await deps.extract_entry(
                conversation_payload(request)
                if request.get("history")
                else request["text"],
                state["context"],
            )
        }

    def validate(state: State) -> JSON:
        validation = normalize_extraction(state["extraction"]["raw"], state["context"])
        result = {"validation": validation}
        if validation["status"] == "rejected":
            result["result"] = clarification_result(validation, request)
        return result

    async def persist(state: State) -> JSON:
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
            raise SemanticError(504, "persist_uncertain", True) from None
        except Exception:
            raise SemanticError(504, "persist_uncertain", True) from None
        return {
            "result": {
                "status": "created",
                "requestId": request["requestId"],
                **completed,
                "metadata": metadata(state["extraction"]),
            }
        }

    def emit(state: State) -> JSON:
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
    with tracing_context(enabled=False):
        final = await graph.compile().ainvoke({}, config={"callbacks": []})
    return final["result"]
