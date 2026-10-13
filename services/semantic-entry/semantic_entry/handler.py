import asyncio
import json
import re
from collections.abc import AsyncIterator
from contextlib import suppress

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from .contracts import JSON, load_json, parse_request, request_id
from .errors import SemanticError
from .graph import Dependencies, invoke

# Strong references only for bounded in-flight requests; no conversation storage.
_operations: set[asyncio.Task[None]] = set()


def error_payload(error: SemanticError) -> JSON:
    return {"error": {"code": error.code, "uncertain": error.uncertain}}


async def stream_operation(
    parsed: JSON, token: str, deps: Dependencies, deadline: float
) -> AsyncIterator[bytes]:
    events: asyncio.Queue[tuple[str, JSON]] = asyncio.Queue()
    writing = False

    async def persisting(payload: JSON) -> None:
        nonlocal writing
        writing = True
        events.put_nowait(("persisting", payload))

    async def operation() -> None:
        try:
            async with asyncio.timeout(deadline):
                result = await invoke(parsed, token, deps, on_persisting=persisting)
                events.put_nowait(("result", result))
        except TimeoutError:
            events.put_nowait(
                ("error", error_payload(SemanticError(504, "persist_uncertain", True)))
            )
        except SemanticError as e:
            events.put_nowait(("error", error_payload(e)))
        except Exception:
            events.put_nowait(
                ("error", error_payload(SemanticError(502, "service_error", writing)))
            )

    task = asyncio.create_task(operation())
    _operations.add(task)
    task.add_done_callback(_operations.discard)
    try:
        while True:
            name, payload = await events.get()
            yield f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()
            if name in ("result", "error"):
                break
    finally:
        if not task.done() and not writing:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        # After RPC begins, response disconnection does not cancel the accepted write.
        # The task retains its own deadline and sanitized exception handling.


async def handle(request: Request, deps: Dependencies) -> Response:
    cors = {"Vary": "Origin", "Cache-Control": "no-store"}

    def error(e: SemanticError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": e.code, "uncertain": e.uncertain}},
            e.status,
            headers=cors,
        )

    origin = request.headers.get("origin")
    if origin:
        if origin not in deps.allowed_origins:
            return error(SemanticError(403, "origin_forbidden"))
        cors["Access-Control-Allow-Origin"] = origin
    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={
                **cors,
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
            },
        )
    path = request.url.path
    # Cloud Run reserves some paths ending in "z", including /healthz.
    if path == "/health" and request.method == "GET":
        return JSONResponse({"status": "ok"}, headers=cors)
    match = re.fullmatch(r"/semantic-entry/([^/]+)", path)
    status_id = match[1] if match else None
    if path != "/semantic-entry" and not status_id:
        return error(SemanticError(404, "not_found"))
    if (status_id and request.method != "GET") or (
        not status_id and request.method != "POST"
    ):
        return error(SemanticError(405, "method_not_allowed"))
    bearer = re.fullmatch(
        r"Bearer (\S+)", request.headers.get("authorization", ""), re.I
    )
    if not bearer:
        return error(SemanticError(401, "unauthorized"))
    started = asyncio.get_running_loop().time()
    try:
        async with asyncio.timeout(deps.http_deadline):
            if status_id:
                try:
                    identifier = request_id(status_id)
                except ValueError:
                    raise SemanticError(400, "invalid_request") from None
                adapter = deps.create_adapter(bearer[1])
                user = await adapter.authenticate()
                await adapter.load_context(user)
                saved = await adapter.lookup_completed(identifier)
                return JSONResponse(
                    {"status": "completed", "requestId": identifier, **saved}
                    if saved
                    else {"status": "not_found", "requestId": identifier},
                    headers=cors,
                )
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 8192:
                    raise SemanticError(400, "body_too_large")
            try:
                parsed = parse_request(load_json(body.decode("utf-8")))
            except (ValueError, TypeError, UnicodeError):
                raise SemanticError(400, "invalid_request") from None
            if "text/event-stream" in request.headers.get("accept", ""):
                remaining = max(
                    0,
                    deps.http_deadline - (asyncio.get_running_loop().time() - started),
                )
                return StreamingResponse(
                    stream_operation(parsed, bearer[1], deps, remaining),
                    media_type="text/event-stream",
                    headers={**cors, "X-Accel-Buffering": "no"},
                )
            result = await invoke(parsed, bearer[1], deps)
            return JSONResponse(
                result, 422 if result["status"] == "rejected" else 200, headers=cors
            )
    except TimeoutError:
        return error(SemanticError(504, "persist_uncertain", True))
    except SemanticError as e:
        return error(e)
    except Exception:
        return error(SemanticError(502, "service_error"))
