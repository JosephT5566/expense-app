from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any

from .contracts import JSON, exact_keys, object_, safe_integer, trim

# Existing expenses.amount is numeric(12,2); semantic entry accepts whole TWD.
MAX_EXPENSE_AMOUNT = 9_999_999_999


def parse_extraction(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(
        r,
        [
            "note",
            "amount",
            "currency",
            "date",
            "payerId",
            "scope",
            "hasSharedIntent",
            "splitMemberIds",
            "categoryId",
            "unsupportedReason",
        ],
    )
    for key in ("note", "currency", "payerId", "categoryId", "unsupportedReason"):
        if r[key] is not None and not isinstance(r[key], str):
            raise ValueError("Invalid extraction")
    if r["amount"] is not None and type(r["amount"]) not in (int, float):
        raise ValueError("Invalid amount")
    if r["scope"] not in (None, "personal", "household"):
        raise ValueError("Invalid scope")
    ids = r["splitMemberIds"]
    if type(r["hasSharedIntent"]) is not bool or (
        ids is not None
        and (not isinstance(ids, list) or any(not isinstance(i, str) for i in ids))
    ):
        raise ValueError("Invalid split")
    d = object_(r["date"])
    exact_keys(d, ["kind", "value"])
    if d["kind"] not in (
        "today",
        "yesterday",
        "day_before_yesterday",
        "absolute",
        "missing",
    ):
        raise ValueError("Invalid date")
    if d["value"] is not None and not isinstance(d["value"], str):
        raise ValueError("Invalid date")
    if d["kind"] != "absolute" and d["value"] is not None:
        raise ValueError("Invalid relative date")
    return r


def valid_date(value: str) -> bool:
    try:
        parsed = date.fromisoformat(value)
        return parsed.isoformat() == value and parsed.year >= 100
    except (ValueError, TypeError):
        return False


def normalize_extraction(raw: Any, ctx: JSON) -> JSON:
    try:
        r = parse_extraction(raw)
    except (ValueError, TypeError):
        return {
            "status": "rejected",
            "issues": [{"field": "extraction", "code": "invalid"}],
        }
    issues: list[JSON] = []

    def issue(field: str, code: str) -> None:
        issues.append({"field": field, "code": code})

    if not r["note"] or not trim(r["note"]):
        issue("note", "missing")
    if r["amount"] is None:
        issue("amount", "missing")
    elif not safe_integer(r["amount"], 1) or r["amount"] > MAX_EXPENSE_AMOUNT:
        issue("amount", "invalid")
    if r["currency"] not in (None, "TWD"):
        issue("currency", "unsupported")
    if r["unsupportedReason"] is not None:
        issue("intent", "unsupported")

    def member(identifier: str) -> JSON | None:
        if identifier == "__ambiguous__":
            issue("members", "ambiguous_member")
            return None
        found = [m for m in ctx["members"] if m["id"] == identifier]
        if len(found) != 1:
            issue("members", "ambiguous_member" if found else "unknown_member")
            return None
        if len([m for m in ctx["members"] if m["email"] == found[0]["email"]]) != 1:
            issue("members", "ambiguous_member")
            return None
        return found[0]

    callers = [m for m in ctx["members"] if m["email"] == ctx["currentUserEmail"]]
    if len(callers) != 1:
        issue("members", "configuration")
    payer = (
        (callers[0] if callers else None)
        if r["payerId"] is None
        else member(r["payerId"])
    )
    scope = (
        r["scope"]
        if r["scope"] is not None
        else ("household" if r["hasSharedIntent"] else "personal")
    )
    shares: JSON = {}
    if scope == "personal":
        if payer and payer["email"] != ctx["currentUserEmail"]:
            issue("payerId", "unsupported")
        if r["hasSharedIntent"] or r["splitMemberIds"] is not None:
            issue("splitMemberIds", "unsupported")
        shares[ctx["currentUserEmail"]] = r["amount"] if r["amount"] is not None else 0
    else:
        ids = r["splitMemberIds"]
        if not ids or len(ids) < 2:
            issue("splitMemberIds", "ambiguous_member")
        elif len(set(ids)) != len(ids):
            issue("splitMemberIds", "invalid")
        else:
            members = sorted(
                (m for i in ids if (m := member(i)) is not None),
                key=lambda m: m["email"],
            )
            if len(members) == len(ids) and safe_integer(r["amount"], 1):
                each, remainder = divmod(int(r["amount"]), len(members))
                shares = {
                    m["email"]: each + (remainder if i == 0 else 0)
                    for i, m in enumerate(members)
                }
    category = (
        r["categoryId"] if r["categoryId"] is not None else ctx["otherCategoryId"]
    )
    if not any(c["id"] == category for c in ctx["categories"]):
        issue("categoryId", "configuration" if r["categoryId"] is None else "invalid")
    day = ctx["today"]
    if not valid_date(day):
        issue("date", "configuration")
    elif r["date"]["kind"] == "absolute":
        absolute = r["date"]["value"]
        if not absolute or not valid_date(absolute) or absolute > day:
            issue("date", "invalid")
        else:
            day = absolute
    else:
        offset = {"yesterday": 1, "day_before_yesterday": 2}.get(r["date"]["kind"], 0)
        day = (date.fromisoformat(day) - timedelta(days=offset)).isoformat()
    if issues or not payer or r["amount"] is None or not r["note"]:
        return {"status": "rejected", "issues": issues}
    # Same Taiwan midnight boundary as src/lib/utils/dates.ts (UTC+08:00).
    ts = (
        datetime.fromisoformat(day)
        .replace(tzinfo=timezone(timedelta(hours=8)))
        .astimezone(UTC)
    )
    return {
        "status": "valid",
        "expense": {
            "note": trim(r["note"]),
            "amount": int(r["amount"]),
            "currency": "TWD",
            "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "payer_email": payer["email"],
            "scope": scope,
            "shares_json": shares,
            "category_id": category,
            "is_settled": scope == "personal",
        },
    }
