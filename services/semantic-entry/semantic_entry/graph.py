import hashlib
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, TypedDict

from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context

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


def input_hash(text: str) -> str:
    return hashlib.sha256(f"v1\n{text}".encode()).hexdigest()


async def invoke(request: JSON, token: str, deps: Dependencies) -> JSON:
    request = parse_request(request)
    adapter = deps.create_adapter(token)
    start = time.monotonic()
    digest = input_hash(request["text"])

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
            "extraction": await deps.extract_entry(request["text"], state["context"])
        }

    def validate(state: State) -> JSON:
        validation = normalize_extraction(state["extraction"]["raw"], state["context"])
        result = {"validation": validation}
        if validation["status"] == "rejected":
            result["result"] = {
                "status": "rejected",
                "requestId": request["requestId"],
                "issues": validation["issues"],
            }
        return result

    async def persist(state: State) -> JSON:
        if state["validation"]["status"] != "valid":
            raise SemanticError(502, "invalid_graph_state")
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
