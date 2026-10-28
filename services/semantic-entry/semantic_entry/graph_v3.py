"""V3 draft graph; text analysis delegates to the frozen v2 graph."""

import time
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context

from .contracts import DRAFT_FIELDS, JSON, parse_request_v3
from .drafts import (
    RECEIPT_PROMPT_VERSION,
    draft_issues,
    expense_from_draft,
    normalize_draft,
    parse_raw_extraction,
)
from .errors import SemanticError, log_failure
from .graph import Dependencies, input_hash_v4, invoke
from .images import ImageMetadata, download_verified, read_verified_metadata
from .provider_stream import AnalysisCallback


class DraftState(TypedDict, total=False):
    user: JSON
    context: JSON
    images: list[ImageMetadata]
    digest: str
    extraction: JSON
    originals: dict[str, JSON]
    raw: JSON
    expenses: list[JSON]
    result: JSON


async def invoke_v3(
    request: JSON,
    token: str,
    deps: Dependencies,
    on_persisting: Callable[[JSON], Awaitable[None]] | None = None,
    on_analysis: AnalysisCallback | None = None,
) -> JSON:
    request = parse_request_v3(request)
    if request["action"] == "analyze" and "images" not in request:
        result = await invoke(
            {k: v for k, v in request.items() if k != "action"},
            token,
            deps,
            on_persisting,
            on_analysis,
        )
        if result["status"] == "created":
            result = {k: v for k, v in result.items() if k != "expense"} | {
                "expenses": [result["expense"]]
            }
        return result

    started = time.monotonic()
    active_node = "initialize"
    action = request["action"]
    identifier = request["requestId"]
    try:
        adapter = deps.create_adapter(token)
    except Exception as error:
        log_failure(
            deps.log,
            "initialize",
            error,
            identifier,
            int((time.monotonic() - started) * 1000),
        )
        raise

    def elapsed() -> int:
        return int((time.monotonic() - started) * 1000)

    def metadata(extraction: JSON | None = None) -> JSON | None:
        if action == "commit":
            return None
        e = extraction or {}
        return {
            "model": e.get("model", "replay"),
            "promptVersion": RECEIPT_PROMPT_VERSION,
            "inputTokens": e.get("inputTokens"),
            "outputTokens": e.get("outputTokens"),
            "elapsedMs": elapsed(),
        }

    async def authenticate(state: DraftState) -> JSON:
        return {"user": await adapter.authenticate()}

    async def load_context(state: DraftState) -> JSON:
        ctx = await adapter.load_context(state["user"])
        return {
            "context": {
                **ctx,
                "referenceDate": request.get("referenceDate", ctx["today"]),
            }
        }

    async def resolve(state: DraftState) -> JSON:
        items = []
        if "images" in request:
            if deps.image_store is None:
                raise SemanticError(502, "image_configuration")
            items = await read_verified_metadata(
                deps.image_store, state["user"]["id"], request["images"]
            )
        if (
            action == "commit"
            and state["context"]["referenceDate"] > state["context"]["today"]
        ):
            raise SemanticError(400, "invalid_request")
        return {
            "images": items,
            "digest": input_hash_v4(
                request,
                [{"path": i.path, "generation": i.generation} for i in items]
                if items
                else None,
            ),
        }

    async def lookup(state: DraftState) -> JSON:
        saved = await adapter.lookup_completed_v3(identifier, state["digest"])
        return (
            {
                "result": {
                    "status": "created",
                    "requestId": identifier,
                    **saved,
                    "metadata": metadata(),
                }
            }
            if saved
            else {}
        )

    async def quota(state: DraftState) -> JSON:
        if state["context"]["referenceDate"] > state["context"]["today"]:
            raise SemanticError(400, "invalid_request")
        if not await adapter.consume_quota():
            raise SemanticError(429, "quota_exceeded")
        return {}

    async def extract(state: DraftState) -> JSON:
        if deps.extract_drafts is None:
            raise SemanticError(502, "provider_configuration")
        images = []
        if "images" in request:
            assert deps.image_store is not None
            images = [
                {"mimeType": mime, "data": data}
                for mime, data in await download_verified(
                    deps.image_store, state["images"]
                )
            ]
        drafts = [
            normalize_draft(d, state["context"], client=True)
            for d in request.get("drafts", [])
        ]
        originals = {d["draftId"]: d for d in drafts}
        # Only client draft fields go back to the model, never trusted status/issues.
        drafts = [
            {k: v for k, v in d.items() if k not in ("status", "issues", "updated")}
            for d in drafts
        ]
        extraction = await deps.extract_drafts(
            {
                "mode": "revise" if action == "revise" else "image",
                "text": request.get("text", ""),
                "history": request.get("history", []),
                "images": images,
                "drafts": drafts,
            },
            state["context"],
        )
        try:
            raw = parse_raw_extraction(extraction["raw"], len(images))
        except (KeyError, TypeError, ValueError):
            raise SemanticError(502, "provider_invalid") from None
        return {"extraction": extraction, "raw": raw, "originals": originals}

    def reject(code: str, field: str = "drafts") -> JSON:
        return {
            "result": {
                "status": "rejected",
                "requestId": identifier,
                "issues": [{"field": field, "code": code}],
            }
        }

    def validate(state: DraftState) -> JSON:
        ctx = state["context"]
        if action == "commit":
            failures = [
                {"draftId": d["draftId"], "issues": issues}
                for d in request["drafts"]
                if (issues := draft_issues(d, ctx, commit=True))
            ]
            if failures:
                result = reject("invalid")
                result["result"]["draftIssues"] = failures
                return result
            return {"expenses": [expense_from_draft(d, ctx) for d in request["drafts"]]}
        raw = state["raw"]
        if not raw["drafts"]:
            return (
                reject("not_a_receipt", "images")
                if state["images"]
                and set(raw["nonReceiptImages"]) == set(range(len(state["images"])))
                else reject("missing")
            )
        if len(raw["drafts"]) > 20:
            return reject("too_many_drafts")
        originals = state["originals"]
        drafts = []
        seen: set[str] = set()
        for r in raw["drafts"]:
            if (
                action == "revise"
                and r["draftId"] is not None
                and r["draftId"] not in originals
            ):
                raise SemanticError(502, "provider_invalid")
            d = normalize_draft(r, ctx, previous=originals.get(r["draftId"]))
            if d["draftId"] in seen:
                raise SemanticError(502, "provider_invalid")
            seen.add(d["draftId"])
            if action == "revise":
                original = originals.get(d["draftId"])
                if original and "mergedFrom" in original:
                    d["mergedFrom"] = original["mergedFrom"]
                if original is None or any(
                    d.get(k) != original.get(k)
                    for k in (*DRAFT_FIELDS, "originalAmount")
                ):
                    d["updated"] = True
            drafts.append(d)
        if (
            action == "analyze"
            and len(drafts) == 1
            and drafts[0]["status"] == "complete"
        ):
            return {"expenses": [expense_from_draft(drafts[0], ctx)]}
        return {
            "result": {
                "status": "drafts",
                "requestId": identifier,
                "drafts": drafts,
                "reason": "multiple" if len(drafts) > 1 else "incomplete",
                "metadata": metadata(state["extraction"]),
            }
        }

    async def persist(state: DraftState) -> JSON:
        if on_persisting:
            await on_persisting({"status": "persisting", "requestId": identifier})
        try:
            if action == "commit":
                saved = await adapter.persist_expenses(
                    identifier, state["digest"], state["expenses"]
                )
            else:
                single = await adapter.persist_expense(
                    identifier, state["digest"], state["expenses"][0]
                )
                saved = {
                    "expenses": [single["expense"]],
                    "replayed": single["replayed"],
                }
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
                "requestId": identifier,
                **saved,
                "metadata": metadata(state.get("extraction")),
            }
        }

    def emit(state: DraftState) -> JSON:
        return {}

    graph = StateGraph(DraftState)
    for name, fn in (
        ("authenticate", authenticate),
        ("load_context", load_context),
        ("metadata", resolve),
        ("lookup", lookup),
        ("quota", quota),
        ("extract", extract),
        ("validate", validate),
        ("persist", persist),
        ("emit", emit),
    ):

        async def node(state: DraftState, fn: Any = fn, name: str = name) -> JSON:
            nonlocal active_node
            active_node = name
            update = fn(state)
            if hasattr(update, "__await__"):
                update = await update
            if deps.log:
                try:
                    deps.log(
                        {
                            "requestId": identifier,
                            "node": name,
                            "status": "ok",
                            "elapsedMs": elapsed(),
                        }
                    )
                except Exception:
                    pass
            return dict(update)

        graph.add_node(name, node)
    for source, target in (
        (START, "authenticate"),
        ("authenticate", "load_context"),
        ("load_context", "metadata"),
        ("metadata", "lookup"),
        ("quota", "extract"),
        ("extract", "validate"),
        ("persist", "emit"),
        ("emit", END),
    ):
        graph.add_edge(source, target)
    graph.add_conditional_edges(
        "lookup",
        lambda s: (
            "emit" if s.get("result") else "validate" if action == "commit" else "quota"
        ),
    )
    graph.add_conditional_edges(
        "validate", lambda s: "emit" if s.get("result") else "persist"
    )
    try:
        with tracing_context(enabled=False):
            final = await graph.compile().ainvoke({}, config={"callbacks": []})
        return dict(final["result"])
    except Exception as error:
        log_failure(deps.log, active_node, error, identifier, elapsed())
        raise
