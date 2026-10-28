import asyncio
import json
import re
from collections.abc import AsyncIterator
from contextlib import suppress
from email.message import Message

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from .contracts import (
    JSON,
    MAX_REQUEST_BYTES_V3,
    load_json,
    load_json_v3,
    parse_request,
    parse_request_v3,
    request_id,
)
from .errors import SemanticError, log_failure
from .graph import Dependencies, invoke
from .graph_v3 import invoke_v3
from .images import issue_upload_urls, parse_upload_request

# Strong references only for bounded in-flight requests; no conversation storage.
_operations: set[asyncio.Task[None]] = set()


def error_payload(error: SemanticError) -> JSON:
    return {"error": {"code": error.code, "uncertain": error.uncertain}}


async def stream_operation(
    parsed: JSON,
    token: str,
    deps: Dependencies,
    deadline: float,
    include_analysis: bool = False,
    version3: bool = False,
) -> AsyncIterator[bytes]:
    started = asyncio.get_running_loop().time()
    events: asyncio.Queue[tuple[str, JSON]] = asyncio.Queue(maxsize=64)
    writing = False
    connected = True
    seq = 0
    analysis_size = 0

    async def analysis(text: str) -> None:
        nonlocal seq, analysis_size
        analysis_size += len(text)
        if not text or analysis_size > 200 or writing:
            raise SemanticError(502, "provider_invalid")
        await events.put(
            (
                "analysis_delta",
                {"requestId": parsed["requestId"], "seq": seq, "text": text},
            )
        )
        seq += 1

    async def persisting(payload: JSON) -> None:
        nonlocal writing
        await events.put(("persisting", payload))
        # No await between this transition and returning to the RPC caller.
        writing = True

    def failure(error: SemanticError) -> None:
        if not connected:
            return
        if events.full():
            # A deadline must still terminate a slow stream. Drop only queued
            # analysis; preserve the writing signal and the terminal error.
            retained = []
            while not events.empty():
                event = events.get_nowait()
                if event[0] != "analysis_delta":
                    retained.append(event)
            for event in retained:
                events.put_nowait(event)
        events.put_nowait(("error", error_payload(error)))

    async def operation() -> None:
        try:
            async with asyncio.timeout(deadline):
                result = await (invoke_v3 if version3 else invoke)(
                    parsed,
                    token,
                    deps,
                    on_persisting=persisting,
                    on_analysis=analysis if include_analysis else None,
                )
                await events.put(("result", result))
        except TimeoutError:
            error = SemanticError(504, "persist_uncertain", True)
            log_failure(
                deps.log,
                "deadline",
                error,
                parsed["requestId"],
                int((asyncio.get_running_loop().time() - started) * 1000),
            )
            failure(error)
        except SemanticError as e:
            failure(e)
        except Exception:
            failure(SemanticError(502, "service_error", writing))

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
        connected = False
        # Release a result enqueue that raced with disconnection after RPC.
        while not events.empty():
            events.get_nowait()
        if not task.done() and not writing:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        # After RPC begins, response disconnection does not cancel the accepted write.
        # The task retains its own deadline and sanitized exception handling.


def accepts_analysis(value: str) -> bool:
    for item in value.split(","):
        message = Message()
        message["content-type"] = item.strip()
        if (
            message.get_content_type() == "text/event-stream"
            and message.get_param("semantic-version") == "2"
            and message.get_param("q", "1") != "0"
        ):
            return True
    return False


def accepts_v3(value: str, media_type: str) -> bool:
    for item in value.split(","):
        message = Message()
        message["content-type"] = item.strip()
        try:
            quality = message.get_param("q", "1")
            enabled = isinstance(quality, str) and float(quality) != 0
        except (ValueError, TypeError):
            enabled = False
        if (
            message.get_content_type() == media_type
            and message.get_param("semantic-version") == "3"
            and enabled
        ):
            return True
    return False


async def handle(request: Request, deps: Dependencies) -> Response:
    operation_start = asyncio.get_running_loop().time()
    identifier: str | None = None
    active_node = "request"
    graph_started = False
    cors = {"Vary": "Origin", "Cache-Control": "no-store"}

    def error(e: SemanticError) -> JSONResponse:
        if not graph_started or active_node == "deadline":
            log_failure(
                deps.log,
                active_node,
                e,
                identifier,
                int((asyncio.get_running_loop().time() - operation_start) * 1000),
            )
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
    if path == "/semantic-entry/uploads":
        if request.method != "POST":
            return error(SemanticError(405, "method_not_allowed"))
        bearer_upload = re.fullmatch(
            r"Bearer (\S+)", request.headers.get("authorization", ""), re.I
        )
        if not bearer_upload:
            return error(SemanticError(401, "unauthorized"))
        try:
            async with asyncio.timeout(deps.http_deadline):
                adapter = deps.create_adapter(bearer_upload[1])
                active_node = "authenticate"
                user = await adapter.authenticate()
                active_node = "load_context"
                await adapter.load_context(user)
                active_node = "uploads"
                if deps.image_store is None:
                    raise SemanticError(502, "image_configuration")
                upload_body = bytearray()
                async for chunk in request.stream():
                    upload_body.extend(chunk)
                    if len(upload_body) > 4096:
                        raise SemanticError(400, "body_too_large")
                try:
                    files = parse_upload_request(load_json(upload_body.decode("utf-8")))
                except (ValueError, TypeError, UnicodeError):
                    raise SemanticError(400, "invalid_request") from None
                return JSONResponse(
                    await issue_upload_urls(deps.image_store, user["id"], files),
                    headers=cors,
                )
        except TimeoutError:
            active_node = "deadline"
            return error(SemanticError(504, "image_error"))
        except SemanticError as e:
            return error(e)
        except Exception:
            return error(SemanticError(502, "image_error"))
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
    accept = request.headers.get("accept", "")
    stream_v3 = accepts_v3(accept, "text/event-stream")
    json_v3 = accepts_v3(accept, "application/json")
    version3 = stream_v3 or json_v3
    try:
        async with asyncio.timeout(deps.http_deadline) as timeout_scope:
            if status_id:
                try:
                    identifier = request_id(status_id)
                except ValueError:
                    raise SemanticError(400, "invalid_request") from None
                adapter = deps.create_adapter(bearer[1])
                active_node = "authenticate"
                user = await adapter.authenticate()
                active_node = "load_context"
                await adapter.load_context(user)
                active_node = "lookup"
                saved = await (
                    adapter.lookup_completed_v3(identifier)
                    if json_v3
                    else adapter.lookup_completed(identifier)
                )
                return JSONResponse(
                    {"status": "completed", "requestId": identifier, **saved}
                    if saved
                    else {"status": "not_found", "requestId": identifier},
                    headers=cors,
                )
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > (MAX_REQUEST_BYTES_V3 if version3 else 8192):
                    raise SemanticError(400, "body_too_large")
            try:
                parsed = (
                    parse_request_v3(load_json_v3(body.decode("utf-8")))
                    if version3
                    else parse_request(load_json(body.decode("utf-8")))
                )
            except (ValueError, TypeError, UnicodeError):
                raise SemanticError(400, "invalid_request") from None
            deadline = deps.http_deadline
            if version3 and parsed["action"] == "analyze" and parsed.get("images"):
                if not 0 < deps.image_deadline < 90:
                    raise SemanticError(502, "image_configuration")
                deadline = deps.image_deadline
                timeout_scope.reschedule(started + deadline)
            if stream_v3 or (not version3 and "text/event-stream" in accept):
                remaining = max(
                    0,
                    deadline - (asyncio.get_running_loop().time() - started),
                )
                return StreamingResponse(
                    stream_operation(
                        parsed,
                        bearer[1],
                        deps,
                        remaining,
                        include_analysis=stream_v3 or accepts_analysis(accept),
                        version3=version3,
                    ),
                    media_type="text/event-stream",
                    headers={**cors, "X-Accel-Buffering": "no"},
                )
            identifier = parsed["requestId"]
            graph_started = True
            result = await (invoke_v3 if version3 else invoke)(parsed, bearer[1], deps)
            return JSONResponse(
                result, 422 if result["status"] == "rejected" else 200, headers=cors
            )
    except TimeoutError:
        active_node = "deadline"
        return error(SemanticError(504, "persist_uncertain", True))
    except SemanticError as e:
        return error(e)
    except Exception:
        return error(SemanticError(502, "service_error"))
