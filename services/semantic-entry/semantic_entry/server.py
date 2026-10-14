import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, Request
from starlette.responses import Response

from .contracts import JSON
from .graph import Dependencies
from .handler import handle
from .provider import DEFAULT_MODEL, Provider
from .supabase import SupabaseAdapter

# Force external payload tracing off, including environment-enabled tracing.
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"


def environment_dependencies(client: httpx.AsyncClient) -> Dependencies:
    names = json.loads(os.environ.get("SEMANTIC_MEMBER_NAMES", "{}"))
    if not isinstance(names, dict) or any(
        not isinstance(v, str) for v in names.values()
    ):
        raise ValueError("Invalid SEMANTIC_MEMBER_NAMES configuration")

    def adapter(token: str) -> SupabaseAdapter:
        return SupabaseAdapter(
            client,
            os.environ.get("SUPABASE_URL", ""),
            os.environ.get("SUPABASE_PUBLISHABLE_KEY", ""),
            names,
            token,
        )

    def log(event: JSON) -> None:
        print(json.dumps(event), flush=True)

    provider = Provider(
        client,
        os.environ.get("GEMINI_API_KEY", ""),
        os.environ.get("SEMANTIC_MODEL", DEFAULT_MODEL),
    )
    return Dependencies(
        adapter,
        provider,
        log,
        tuple(
            o.strip()
            for o in os.environ.get("SEMANTIC_ALLOWED_ORIGINS", "").split(",")
            if o.strip()
        ),
        stream_entry=provider.stream,
    )


def create_app(deps: Dependencies | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with httpx.AsyncClient(
            timeout=30, transport=httpx.AsyncHTTPTransport(retries=0)
        ) as client:
            app.state.deps = deps or environment_dependencies(client)
            yield

    async def endpoint(request: Request) -> Response:
        return await handle(request, deps or request.app.state.deps)

    app = FastAPI(
        lifespan=lifespan,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        redirect_slashes=False,
    )
    # Read Request directly so the portable validators, body limit and wire
    # errors remain authoritative instead of FastAPI's automatic validation.
    app.add_api_route("/health", endpoint, methods=["GET"], name="health")
    app.add_api_route(
        "/semantic-entry", endpoint, methods=["POST"], name="create_entry"
    )
    app.add_api_route(
        "/semantic-entry/{requestId}",
        endpoint,
        methods=["GET"],
        name="lookup_entry",
    )
    # Last route preserves CORS preflight and JSON errors for unknown paths
    # and unsupported methods, including origin checks before route errors.
    app.add_api_route(
        "/{path:path}",
        endpoint,
        methods=[
            "GET",
            "POST",
            "OPTIONS",
            "HEAD",
            "PUT",
            "PATCH",
            "DELETE",
            "TRACE",
            "CONNECT",
        ],
        include_in_schema=False,
    )
    return app


def main() -> None:
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        access_log=False,
        timeout_keep_alive=5,
    )


if __name__ == "__main__":
    main()
