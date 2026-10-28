"""Untrusted draft normalization, completeness and value-only commit validation."""

import math
import re
from copy import deepcopy
from datetime import UTC, datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

from .contracts import (
    DRAFT_FIELDS,
    JSON,
    exact_keys,
    object_,
    parse_draft_v3,
    request_id,
    safe_integer,
    trim,
)
from .errors import SemanticError
from .normalize import MAX_EXPENSE_AMOUNT, equal_shares, valid_date

RECEIPT_PROMPT_VERSION = "semantic-receipt-v1"


def parse_raw_extraction(raw: object, image_count: int) -> JSON:
    try:
        r = object_(raw)
        exact_keys(r, ["drafts", "nonReceiptImages"])
        if not isinstance(r["drafts"], list) or not isinstance(
            r["nonReceiptImages"], list
        ):
            raise ValueError("Invalid extraction lists")
        if any(
            type(i) is not int or not 0 <= i < image_count
            for i in r["nonReceiptImages"]
        ):
            raise ValueError("Invalid image index")
        for raw_draft in r["drafts"]:
            d = object_(raw_draft)
            exact_keys(d, ["draftId", *DRAFT_FIELDS, "originalAmountText"])
            if d["draftId"] is not None:
                request_id(d["draftId"])
            if d["originalAmountText"] is not None and not isinstance(
                d["originalAmountText"], str
            ):
                raise ValueError("Invalid original amount")
            for key in DRAFT_FIELDS:
                f = object_(d[key])
                exact_keys(f, ["value", "state", "confidence", "source"])
                if f["state"] not in (
                    "recognized",
                    "unrecognized",
                    "missing",
                    "explicit_null",
                ) or f["source"] not in ("image", "text", "default", "user"):
                    raise ValueError("Invalid field")
        return deepcopy(r)
    except (ValueError, TypeError):
        raise SemanticError(502, "provider_invalid") from None


def draft_issues(draft: JSON, ctx: JSON, *, commit: bool = False) -> list[JSON]:
    issues: list[JSON] = []

    def issue(field: str, code: str) -> None:
        item = {"field": field, "code": code}
        if item not in issues:
            issues.append(item)

    values = {k: draft[k]["value"] for k in DRAFT_FIELDS}
    household = values["scope"] == "household"
    for key in DRAFT_FIELDS:
        f = draft[key]
        required = key != "splitMemberEmails" or household
        if required and f["value"] is None:
            issue(
                key,
                "unrecognized"
                if not commit and f["state"] == "unrecognized"
                else "missing",
            )
        if not commit:
            if f["state"] in ("unrecognized", "missing"):
                issue(key, f["state"])
            if f["source"] == "image":
                if f["confidence"] is not None and f["confidence"] < 0.7:
                    issue(key, "low_confidence")
                elif f["state"] == "recognized" and f["confidence"] is None:
                    issue(key, "missing_confidence")
    if values["note"] is not None and (
        not isinstance(values["note"], str) or not trim(values["note"])
    ):
        issue("note", "invalid")
    amount = values["amount"]
    if amount is not None and (
        not safe_integer(amount, 1) or amount > MAX_EXPENSE_AMOUNT
    ):
        issue("amount", "invalid")
    if values["currency"] is not None and values["currency"] != "TWD":
        issue("currency", "non_twd")
    day = values["date"]
    if day is not None:
        if not valid_date(day):
            issue("date", "invalid")
        elif day > ctx["today"]:
            issue("date", "future_date")
    if not commit and draft["date"]["defaulted"] == "unreadable":
        issue("date", "date_defaulted")
    if values["categoryId"] not in {c["id"] for c in ctx["categories"]}:
        issue("categoryId", "invalid")
    if values["scope"] is not None and values["scope"] not in ("personal", "household"):
        issue("scope", "invalid")
    members = {m["email"] for m in ctx["members"]}
    payer = values["payerEmail"]
    if payer is not None and payer not in members:
        issue("payerEmail", "unknown_member")
    if (
        values["scope"] == "personal"
        and payer is not None
        and payer != ctx["currentUserEmail"]
    ):
        issue("payerEmail", "invalid")
    if household:
        emails = values["splitMemberEmails"] or []
        if any(e not in members for e in emails):
            issue("splitMemberEmails", "unknown_member")
        if len(set(emails)) < 2:
            issue("splitMemberEmails", "invalid")
    return issues


def normalize_draft(raw: JSON, ctx: JSON, *, client: bool = False) -> JSON:
    d: JSON = {"draftId": raw["draftId"] or str(uuid4())}
    for key in DRAFT_FIELDS:
        f = deepcopy(raw[key])
        f.pop("defaulted", None)
        if f["state"] == "recognized" and f["value"] is None:
            f["state"] = "missing"
        if f["state"] == "explicit_null":
            f["value"] = None
        confidence = f["confidence"]
        if (
            type(confidence) not in (int, float)
            or not 0 <= confidence <= 1
            or not math.isfinite(confidence)
        ):
            f["confidence"] = None
        d[key] = f

    def invalid(key: str) -> None:
        d[key].update(value=None, state="unrecognized")

    def default(key: str, value: object) -> None:
        d[key].update(
            value=value, state="recognized", source="default", confidence=None
        )

    note = d["note"]["value"]
    if isinstance(note, str):
        d["note"]["value"] = trim(note)[:200] or None
    elif note is not None:
        invalid("note")
    currency = d["currency"]["value"]
    if currency is None:
        default("currency", "TWD")
    elif isinstance(currency, str) and re.fullmatch(r"[A-Za-z]{3}", currency):
        d["currency"]["value"] = currency.upper()
    else:
        invalid("currency")
    amount = d["amount"]["value"]
    if amount is not None:
        if (
            type(amount) in (int, float)
            and 0 < amount <= MAX_EXPENSE_AMOUNT
            and math.isfinite(amount)
        ):
            d["amount"]["value"] = math.ceil(amount)
        else:
            invalid("amount")
    currency = d["currency"]["value"]
    fractional = (
        type(amount) is float and math.isfinite(amount) and amount != int(amount)
    )
    if fractional or currency not in (None, "TWD"):
        text = raw.get("originalAmountText") or str(amount)
        d["originalAmount"] = {
            "text": trim(text)[:200] or str(amount),
            "currency": currency or "TWD",
        }
    elif client and "originalAmount" in raw:
        d["originalAmount"] = deepcopy(raw["originalAmount"])
    day = d["date"]["value"]
    d["date"]["defaulted"] = None
    if not isinstance(day, str) or not valid_date(day):
        default("date", ctx["today"])
        d["date"]["defaulted"] = "unreadable"
    elif day > ctx["today"]:
        d["date"].update(value=ctx["today"], defaulted="future")
    elif client:
        d["date"]["defaulted"] = raw["date"].get("defaulted")
    if not isinstance(d["categoryId"]["value"], str) or d["categoryId"][
        "value"
    ] not in {c["id"] for c in ctx["categories"]}:
        invalid("categoryId")
    if d["scope"]["value"] is None:
        default("scope", "personal")
    elif d["scope"]["value"] not in ("personal", "household"):
        invalid("scope")
    members = {m["email"] for m in ctx["members"]}
    if d["payerEmail"]["value"] is None:
        default("payerEmail", ctx["currentUserEmail"])
    elif (
        not isinstance(d["payerEmail"]["value"], str)
        or d["payerEmail"]["value"] not in members
    ):
        invalid("payerEmail")
    split = d["splitMemberEmails"]["value"]
    extra_issues: list[JSON] = []
    if (
        raw["payerEmail"]["value"] is not None
        and d["payerEmail"]["state"] == "unrecognized"
    ):
        extra_issues.append({"field": "payerEmail", "code": "unknown_member"})
    if d["scope"]["value"] == "personal":
        if split is None:
            default("splitMemberEmails", [ctx["currentUserEmail"]])
        else:
            d["splitMemberEmails"]["value"] = [ctx["currentUserEmail"]]
    elif split is not None:
        if not isinstance(split, list) or any(
            not isinstance(e, str) or e not in members for e in split
        ):
            invalid("splitMemberEmails")
            extra_issues.append(
                {"field": "splitMemberEmails", "code": "unknown_member"}
            )
        else:
            d["splitMemberEmails"]["value"] = list(dict.fromkeys(split))
    if client and "mergedFrom" in raw:
        d["mergedFrom"] = deepcopy(raw["mergedFrom"])
    issues = draft_issues(d, ctx)
    for item in extra_issues:
        if item not in issues:
            issues.append(item)
    d.update(status="incomplete" if issues else "complete", issues=issues)
    try:
        return parse_draft_v3(d)
    except (ValueError, TypeError):
        raise SemanticError(502, "provider_invalid") from None


def expense_from_draft(d: JSON, ctx: JSON) -> JSON:
    v = {k: d[k]["value"] for k in DRAFT_FIELDS}
    ts = (
        datetime.fromisoformat(v["date"])
        .replace(tzinfo=ZoneInfo("Asia/Taipei"))
        .astimezone(UTC)
    )
    emails = (
        [ctx["currentUserEmail"]]
        if v["scope"] == "personal"
        else list(set(v["splitMemberEmails"]))
    )
    return {
        "note": trim(v["note"]),
        "amount": v["amount"],
        "currency": "TWD",
        "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "payer_email": v["payerEmail"],
        "scope": v["scope"],
        "shares_json": equal_shares(v["amount"], emails),
        "category_id": v["categoryId"],
        "is_settled": v["scope"] == "personal",
    }
