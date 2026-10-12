FROM ghcr.io/astral-sh/uv:0.12.7 AS uv
FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY services/semantic-entry/pyproject.toml services/semantic-entry/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python
COPY services/semantic-entry/semantic_entry semantic_entry
RUN uv sync --locked --no-dev --python /usr/local/bin/python

FROM python:3.12-slim-bookworm AS runtime
ENV PORT=8080 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH"
WORKDIR /app
RUN groupadd --gid 10001 semantic && useradd --uid 10001 --gid semantic --no-create-home semantic
COPY --from=build --chown=semantic:semantic /app/.venv .venv
COPY --from=build --chown=semantic:semantic /app/semantic_entry semantic_entry
USER semantic
EXPOSE 8080
CMD ["python", "-m", "semantic_entry.server"]
