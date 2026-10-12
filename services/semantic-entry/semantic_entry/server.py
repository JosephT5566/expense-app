import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from .contracts import JSON
from .graph import Dependencies
from .handler import handle
from .provider import Provider
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
            os.environ.get("SEMANTIC_OTHER_CATEGORY_ID", ""),
            token,
        )

    def log(event: JSON) -> None:
        print(json.dumps(event), flush=True)

    return Dependencies(
        adapter,
        Provider(
            client,
            os.environ.get("OPENAI_API_KEY", ""),
            os.environ.get("SEMANTIC_MODEL", "gpt-5.4-mini"),
        ),
        log,
        tuple(
            o.strip()
            for o in os.environ.get("SEMANTIC_ALLOWED_ORIGINS", "").split(",")
            if o.strip()
        ),
    )


def create_app(deps: Dependencies | None = None) -> Starlette:
    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with httpx.AsyncClient(
            timeout=30, transport=httpx.AsyncHTTPTransport(retries=0)
        ) as client:
            app.state.deps = deps or environment_dependencies(client)
            yield

    async def endpoint(request: Request) -> Response:
        return await handle(request, deps or request.app.state.deps)

    # Catch all paths/methods so API errors have the same wire shape.
    return Starlette(
        routes=[
            Route(
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
            )
        ],
        lifespan=lifespan,
    )


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
