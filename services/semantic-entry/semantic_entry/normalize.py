import math
from datetime import UTC, date, datetime, timedelta, timezone
from fractions import Fraction
from typing import Any

from .contracts import JSON, exact_keys, object_, safe_integer, trim

# Existing expenses.amount is numeric(12,2); semantic entry accepts whole TWD.
MAX_EXPENSE_AMOUNT = 9_999_999_999


def parse_extraction(raw: Any) -> JSON:
    r = dict(object_(raw))
    # Missing personal fields are equivalent to explicit null only when the
    # provider explicitly rules out sharing. Preserve all supplied values.
    if r.get("hasSharedIntent") is False and r.get("scope") in (None, "personal"):
        for key in ("payerId", "scope", "splitMemberIds"):
            r.setdefault(key, None)
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
        ["shares", "splitDifference", "splitRatio"],
    )
    validate_split_fields(r)
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


def validate_split_fields(raw: JSON) -> None:
    def finite_number(value: Any) -> bool:
        return type(value) is int or type(value) is float and math.isfinite(value)

    difference = raw.get("splitDifference")
    if difference is not None and (
        not finite_number(difference) or abs(difference) > MAX_EXPENSE_AMOUNT
    ):
        raise ValueError("Invalid split difference")
    for key in ("shares", "splitRatio"):
        values = raw.get(key)
        if values is not None and (
            not isinstance(values, dict)
            or any(
                not isinstance(identifier, str)
                or not trim(identifier)
                or not finite_number(value)
                for identifier, value in values.items()
            )
        ):
            raise ValueError("Invalid split amounts")


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
    if r["unsupportedReason"] not in (None, "unequal_split", "custom_split"):
        issue("intent", "unsupported")

    def member(identifier: str, field: str) -> JSON | None:
        found, code = resolve_member(identifier, ctx)
        if code:
            issue(field, code)
        return found

    callers = [m for m in ctx["members"] if m["email"] == ctx["currentUserEmail"]]
    if len(callers) != 1:
        issue("members", "configuration")
    payer = (
        (callers[0] if callers else None)
        if r["payerId"] is None
        else member(r["payerId"], "payerId")
    )
    scope = (
        r["scope"]
        if r["scope"] is not None
        else ("household" if r["hasSharedIntent"] else "personal")
    )
    if r["unsupportedReason"] in ("unequal_split", "custom_split") or any(
        r.get(k) is not None for k in ("splitDifference", "splitRatio")
    ):
        scope = "household"
    shares: JSON = {}
    split_context: JSON | None = None
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
                (m for i in ids if (m := member(i, "splitMemberIds")) is not None),
                key=lambda m: m["email"],
            )
            emails = [m["email"] for m in members]
            if len(members) == len(ids) and len(set(emails)) != len(ids):
                issue("splitMemberIds", "invalid")
            elif len(members) == len(ids) and safe_integer(r["amount"], 1):
                computed, code = split_shares(r, r["amount"], emails, ctx)
                if code:
                    issue(
                        "members"
                        if code in ("unknown_member", "ambiguous_member")
                        else "shares",
                        code,
                    )
                    shares = equal_shares(r["amount"], emails)
                    split_context = {
                        "amount": r["amount"],
                        "emails": emails,
                        "difference": r.get("splitDifference"),
                    }
                else:
                    assert computed is not None
                    shares = computed
    if scope == "personal" and r.get("shares") is not None:
        custom, code = split_shares(r, r["amount"], [ctx["currentUserEmail"]], ctx)
        if code:
            issue(
                "members"
                if code in ("unknown_member", "ambiguous_member")
                else "shares",
                code,
            )
        else:
            assert custom is not None
            shares = custom
    category = r["categoryId"]
    if not ctx["categories"]:
        issue("categoryId", "configuration")
    elif category is None or not trim(category):
        issue("categoryId", "missing")
    elif not any(c["id"] == category for c in ctx["categories"]):
        issue("categoryId", "invalid")
    day = ctx["referenceDate"] if "referenceDate" in ctx else ctx["today"]
    if not valid_date(day) or not valid_date(ctx["today"]) or day > ctx["today"]:
        issue("date", "configuration")
    elif r["date"]["kind"] == "absolute":
        absolute = r["date"]["value"]
        if not absolute or not valid_date(absolute) or absolute > ctx["today"]:
            issue("date", "invalid")
        else:
            day = absolute
    else:
        offset = {"yesterday": 1, "day_before_yesterday": 2}.get(r["date"]["kind"], 0)
        day = (date.fromisoformat(day) - timedelta(days=offset)).isoformat()
    if issues and (not split_context or any(i["field"] != "shares" for i in issues)):
        return {"status": "rejected", "issues": issues}
    if not payer or r["amount"] is None or not r["note"]:
        return {"status": "rejected", "issues": issues}
    # Same Taiwan midnight boundary as src/lib/utils/dates.ts (UTC+08:00).
    ts = (
        datetime.fromisoformat(day)
        .replace(tzinfo=timezone(timedelta(hours=8)))
        .astimezone(UTC)
    )
    expense = {
        "note": trim(r["note"]),
        "amount": int(r["amount"]),
        "currency": "TWD",
        "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "payer_email": payer["email"],
        "scope": scope,
        "shares_json": shares,
        "category_id": category,
        "is_settled": scope == "personal",
    }
    if issues:
        return {
            "status": "rejected",
            "issues": issues,
            "splitContext": split_context,
            "candidateExpense": expense,
        }
    return {"status": "valid", "expense": expense}


def resolve_member(identifier: object, ctx: JSON) -> tuple[JSON | None, str | None]:
    """Resolve only exact trusted identifiers; never infer relationships or fuzzy names."""
    if not isinstance(identifier, str):
        return None, "unknown_member"
    if identifier == "__ambiguous__":
        return None, "ambiguous_member"
    query = identifier.casefold()
    if identifier == "我":
        query = ctx["currentUserEmail"].casefold()
    found = [
        m
        for m in ctx["members"]
        if query in {m[k].casefold() for k in ("id", "email", "name")}
    ]
    if len(found) != 1:
        return None, "ambiguous_member" if found else "unknown_member"
    if (
        sum(
            m["email"].casefold() == found[0]["email"].casefold()
            for m in ctx["members"]
        )
        != 1
    ):
        return None, "ambiguous_member"
    return found[0], None


def split_shares(
    raw: JSON, amount: Any, emails: list[str], ctx: JSON
) -> tuple[JSON | None, str | None]:
    """Compute exact relations with rational arithmetic; an inexact result needs consent."""
    if not safe_integer(amount, 1) or not emails:
        return None, "invalid"
    amount = int(amount)
    custom = raw.get("shares")
    ratio = raw.get("splitRatio")
    difference = raw.get("splitDifference")
    if custom is not None or ratio is not None:
        values = custom if custom is not None else ratio
        if not isinstance(values, dict) or not values:
            return None, "invalid"
        resolved: JSON = {}
        for identifier, value in values.items():
            member, code = resolve_member(identifier, ctx)
            if code:
                return None, code
            assert member is not None
            email = member["email"]
            if email in resolved or email not in emails:
                return None, "invalid"
            if custom is not None:
                if not safe_integer(value, 0):
                    return None, "invalid"
                resolved[email] = int(value)
            else:
                if type(value) not in (int, float):
                    return None, "invalid"
                try:
                    weight = Fraction(str(value))
                except (ValueError, OverflowError):
                    return None, "invalid"
                if weight <= 0:
                    return None, "invalid"
                resolved[email] = weight
        if set(resolved) != set(emails):
            return None, "invalid"
        if custom is not None:
            return (
                (resolved, None)
                if sum(resolved.values()) == amount
                else (None, "invalid")
            )
        total_weight = sum(resolved.values())
        parts = {
            email: amount * weight / total_weight for email, weight in resolved.items()
        }
        if any(value.denominator != 1 for value in parts.values()):
            return None, "custom_required"
        return {email: int(value) for email, value in parts.items()}, None
    if difference is not None:
        if (
            type(difference) not in (int, float)
            or len(emails) != 2
            or ctx["currentUserEmail"] not in emails
        ):
            return None, "custom_required"
        try:
            caller_amount = (Fraction(amount) + Fraction(str(difference))) / 2
        except (ValueError, OverflowError):
            return None, "invalid"
        if not 0 <= caller_amount <= amount:
            return None, "invalid"
        if caller_amount.denominator != 1:
            return None, "custom_required"
        return {
            email: int(caller_amount)
            if email == ctx["currentUserEmail"]
            else amount - int(caller_amount)
            for email in emails
        }, None
    if raw.get("unsupportedReason") in ("unequal_split", "custom_split"):
        return None, "custom_required"
    return equal_shares(amount, emails), None


def equal_shares(amount: int, emails: list[str]) -> JSON:
    ordered = sorted(emails)
    each, remainder = divmod(int(amount), len(ordered))
    return {
        email: each + (remainder if i == 0 else 0) for i, email in enumerate(ordered)
    }
