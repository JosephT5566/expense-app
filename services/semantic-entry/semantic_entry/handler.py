import asyncio
import re

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .contracts import load_json, parse_request, request_id
from .errors import SemanticError
from .graph import Dependencies, invoke


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
    if path == "/healthz" and request.method == "GET":
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
