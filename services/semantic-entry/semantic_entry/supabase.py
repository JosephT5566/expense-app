import json
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from .contracts import JSON, object_, parse_completed_result, parse_expense_row
from .errors import SemanticError


def database_expense(raw: object) -> JSON:
    """Adapt JSONB metadata to the existing string-based browser contract."""
    row = dict(object_(raw))
    if "meta" in row and not isinstance(row["meta"], str):
        row["meta"] = json.dumps(
            row["meta"], ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
    return parse_expense_row(row)


class SupabaseAdapter:
    """HTTPS Data API adapter; every call uses the verified caller's JWT."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        url: str,
        publishable_key: str,
        member_names: dict[str, str],
        token: str,
    ):
        self.client = client
        self.url = url.rstrip("/")
        self.headers = {"apikey": publishable_key, "Authorization": f"Bearer {token}"}
        self.member_names = member_names
        self.verified: JSON | None = None

    async def call(
        self,
        method: str,
        path: str,
        *,
        params: JSON | None = None,
        body: JSON | None = None,
        uncertain: bool = False,
    ) -> object:
        try:
            response = await self.client.request(
                method, self.url + path, headers=self.headers, params=params, json=body
            )
            if not response.is_success:
                try:
                    code = response.json().get("code", "")
                except (ValueError, AttributeError):
                    code = ""
                if code in {f"PT{s}" for s in (400, 401, 403, 409, 422, 429)}:
                    status = int(code[2:])
                    diagnostics: JSON = {}
                    if status == 422:
                        try:
                            details = json.loads(response.json().get("details", ""))
                            index = (
                                details.get("index")
                                if isinstance(details, dict)
                                else None
                            )
                            if type(index) is int and index >= 0:
                                diagnostics["rowIndex"] = index
                        except (ValueError, TypeError):
                            pass
                    raise SemanticError(
                        status,
                        "conflict" if status == 409 else "rpc_rejected",
                        diagnostics=diagnostics,
                    )
                raise SemanticError(
                    504 if uncertain else 502,
                    "persist_uncertain" if uncertain else "database_error",
                    uncertain,
                )
            return response.json()
        except (httpx.HTTPError, ValueError):
            raise SemanticError(
                504 if uncertain else 502,
                "persist_uncertain" if uncertain else "database_error",
                uncertain,
            ) from None

    async def authenticate(self) -> JSON:
        try:
            data = await self.call("GET", "/auth/v1/user")
        except SemanticError:
            raise SemanticError(401, "unauthorized") from None
        if not isinstance(data, dict) or not data.get("id") or not data.get("email"):
            raise SemanticError(401, "unauthorized")
        self.verified = {"id": data["id"], "email": data["email"]}
        return self.verified

    async def load_context(self, user: JSON) -> JSON:
        if not self.verified or self.verified["id"] != user["id"]:
            raise SemanticError(401, "unauthorized")
        import asyncio

        settings, categories = await asyncio.gather(
            self.call(
                "GET",
                "/rest/v1/app_settings",
                params={"select": "allowed_emails", "id": "eq.true"},
            ),
            self.call(
                "GET",
                "/rest/v1/categories",
                params={"select": "id,name", "kind": "eq.expense"},
            ),
        )
        if (
            not isinstance(settings, list)
            or len(settings) != 1
            or not isinstance(settings[0], dict)
        ):
            raise SemanticError(502, "database_invalid")
        emails = settings[0].get("allowed_emails")
        if (
            not isinstance(emails, list)
            or any(not isinstance(e, str) for e in emails)
            or user["email"] not in emails
        ):
            raise SemanticError(403, "forbidden")
        if not isinstance(categories, list) or any(
            not isinstance(c, dict)
            or not isinstance(c.get("id"), str)
            or not isinstance(c.get("name"), str)
            for c in categories
        ):
            raise SemanticError(502, "database_invalid")
        return {
            "today": datetime.now(ZoneInfo("Asia/Taipei")).date().isoformat(),
            "currentUserEmail": user["email"],
            "members": [
                {"id": f"member-{i}", "email": e, "name": self.member_names.get(e, e)}
                for i, e in enumerate(emails)
            ],
            "categories": categories,
        }

    async def lookup_completed(
        self, request_id: str, input_hash: str | None = None
    ) -> JSON | None:
        if not self.verified:
            raise SemanticError(401, "unauthorized")
        data = await self.call(
            "GET",
            "/rest/v1/semantic_entry_requests",
            params={
                "select": "input_hash,result",
                "user_id": f"eq.{self.verified['id']}",
                "request_id": f"eq.{request_id}",
            },
        )
        if data == []:
            return None
        if (
            not isinstance(data, list)
            or len(data) != 1
            or not isinstance(data[0], dict)
        ):
            raise SemanticError(502, "database_invalid")
        if input_hash and data[0].get("input_hash") != input_hash:
            raise SemanticError(409, "conflict")
        if (
            isinstance(data[0].get("result"), dict)
            and data[0]["result"].get("batch") is True
        ):
            raise SemanticError(409, "unsupported_version")
        try:
            return {
                "expense": database_expense(data[0].get("result")),
                "replayed": True,
            }
        except (ValueError, TypeError):
            raise SemanticError(502, "database_invalid") from None

    async def consume_quota(self) -> bool:
        data = await self.call(
            "POST", "/rest/v1/rpc/consume_semantic_entry_quota", body={}
        )
        if type(data) is not bool:
            raise SemanticError(502, "database_invalid")
        return data

    async def persist_expense(
        self, request_id: str, input_hash: str, expense: JSON
    ) -> JSON:
        data = await self.call(
            "POST",
            "/rest/v1/rpc/create_semantic_expense",
            body={
                "p_request_id": request_id,
                "p_input_hash": input_hash,
                "p_expense": expense,
            },
            uncertain=True,
        )
        try:
            result = dict(object_(data))
            if isinstance(result.get("expense"), dict) and "batch" in result["expense"]:
                raise SemanticError(409, "conflict")
            result["expense"] = database_expense(result.get("expense"))
            return parse_completed_result(result)
        except (ValueError, TypeError):
            raise SemanticError(504, "persist_uncertain", True) from None

    async def lookup_completed_v3(
        self, request_id: str, input_hash: str | None = None
    ) -> JSON | None:
        if not self.verified:
            raise SemanticError(401, "unauthorized")
        data = await self.call(
            "GET",
            "/rest/v1/semantic_entry_requests",
            params={
                "select": "input_hash,result",
                "user_id": f"eq.{self.verified['id']}",
                "request_id": f"eq.{request_id}",
            },
        )
        if data == []:
            return None
        if (
            not isinstance(data, list)
            or len(data) != 1
            or not isinstance(data[0], dict)
        ):
            raise SemanticError(502, "database_invalid")
        if input_hash and data[0].get("input_hash") != input_hash:
            raise SemanticError(409, "conflict")
        try:
            result = object_(data[0].get("result"))
            if result.get("batch") is True:
                if set(result) != {"batch", "expenses"}:
                    raise ValueError("Invalid batch snapshot")
                expenses = self.batch_rows(result["expenses"])
            else:
                expenses = [database_expense(result)]
            return {"expenses": expenses, "replayed": True}
        except (ValueError, TypeError):
            raise SemanticError(502, "database_invalid") from None

    @staticmethod
    def batch_rows(raw: object) -> list[JSON]:
        if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
            raise ValueError("Invalid expense batch")
        return [database_expense(row) for row in raw]

    async def persist_expenses(
        self, request_id: str, input_hash: str, expenses: list[JSON]
    ) -> JSON:
        data = await self.call(
            "POST",
            "/rest/v1/rpc/create_semantic_expenses",
            body={
                "p_request_id": request_id,
                "p_input_hash": input_hash,
                "p_expenses": expenses,
            },
            uncertain=True,
        )
        try:
            result = object_(data)
            if (
                set(result) != {"expenses", "replayed"}
                or type(result["replayed"]) is not bool
            ):
                raise ValueError("Invalid batch response")
            rows = self.batch_rows(result["expenses"])
            if len(rows) != len(expenses):
                raise ValueError("Batch length mismatch")
            return {"expenses": rows, "replayed": result["replayed"]}
        except (ValueError, TypeError):
            raise SemanticError(504, "persist_uncertain", True) from None
