"""Select one exact-member relationship and compute whole-integer item shares."""

import re
from copy import deepcopy
from datetime import datetime
from typing import Any

from .contracts import JSON, safe_integer
from .history_tool import (
    HISTORY_TRIGGER,
    explicit_history_split,
    history_text,
    references_history,
    sanitize_rows,
)
from .normalize import equal_shares, resolve_member, split_shares


def history_applies(items: list[JSON], request: JSON, queries: int) -> bool:
    if queries:
        return True
    text = history_text(request)
    shared = any(
        i.get("hasSharedIntent") or i.get("scope") == "household" for i in items
    )
    # Only a separate, explicit current-turn split can disambiguate purchase history.
    punctuation = r"[，,。.!！?？:：、;；\n]"
    current_purchase_split = re.fullmatch(
        r"\s*(?:"
        + HISTORY_TRIGGER.pattern
        + r")(?:買|的)"
        + r"[^，,。.!！?？:：、;；\n]+"
        + punctuation
        + r"+[^，,。.!！?？:：、;；\n]*(?:這次|本次|this\s+time)\s*"
        + r"(?:平分|平攤|均分|分攤|分|攤|拆|AA|split|share)[\s。.!！?？]*",
        text,
        re.IGNORECASE,
    )
    return bool(
        explicit_history_split(request)
        or shared
        and references_history(request)
        and not (current_purchase_split and len(HISTORY_TRIGGER.findall(text)) == 1)
    )


def prepare_history(
    originals: list[JSON], rows: list[JSON], ctx: JSON, request: JSON | None = None
) -> tuple[list[JSON], JSON | None]:
    items = deepcopy(originals)
    for item in items:
        item.update(
            scope="household",
            hasSharedIntent=True,
            shares={},
            splitDifference=None,
            splitRatio=None,
        )
        if "unsupportedReason" in item and item["unsupportedReason"] in (
            "unequal_split",
            "custom_split",
        ):
            item["unsupportedReason"] = None

    def members(raw: JSON) -> list[str] | None:
        ids = raw.get("splitMemberIds")
        if not isinstance(ids, list) or len(ids) < 2:
            return None
        resolved = [resolve_member(i, ctx)[0] for i in ids]
        if any(m is None for m in resolved):
            return None
        emails = [m["email"] for m in resolved if m is not None]
        return sorted(emails) if len(set(emails)) == len(ids) else None

    if not items:
        return items, None
    emails = members(items[0])
    if emails is None or any(members(i) != emails for i in items):
        return items, None
    if request is not None and not explicitly_named(emails, request, ctx):
        for item in items:
            item["splitMemberIds"] = None
        return items, None
    matches = [r for r in sanitize_rows(rows) if set(r["shares_json"]) == set(emails)]
    if not matches:
        return items, None
    latest = max(
        datetime.fromisoformat(r["ts"].replace("Z", "+00:00")) for r in matches
    )
    matches = [
        r
        for r in matches
        if datetime.fromisoformat(r["ts"].replace("Z", "+00:00")) == latest
    ]
    if len(matches) != 1:
        return items, None
    row = matches[0]
    amounts = [i.get("amount") for i in items]
    if any(not safe_integer(a, 1) for a in amounts):
        return items, None
    if row["shares_json"] == equal_shares(row["amount"], emails):
        for item in items:
            item["shares"] = equal_shares(item["amount"], emails)
        return items, None
    # Choose one relationship for the whole receipt, never a different relation per item.
    relations: list[JSON] = [{"splitRatio": row["shares_json"]}]
    if len(emails) == 2 and ctx["currentUserEmail"] in emails:
        caller = ctx["currentUserEmail"]
        other = next(e for e in emails if e != caller)
        relations.append(
            {"splitDifference": row["shares_json"][caller] - row["shares_json"][other]}
        )
    if all(a == row["amount"] for a in amounts):
        relations.insert(0, {"shares": row["shares_json"]})
    for relation in relations:
        calculated = [historical_shares(relation, a, emails, ctx) for a in amounts]
        if any(code for _, code in calculated):
            continue
        for item, (shares, _) in zip(items, calculated, strict=True):
            item["shares"] = shares
        return items, {
            "amount": amounts[0],
            "emails": emails,
            "difference": None,
            "historicalShares": calculated[0][0],
            "historicalRelation": relation,
        }
    return items, None


def explicitly_named(emails: list[str], request: JSON, ctx: JSON) -> bool:
    """A lookup must not supply participants that the user never identified."""
    drafts = request.get("drafts", [])
    if drafts:
        carried = []
        for draft in drafts:
            identifiers = draft["splitMemberEmails"]["value"] or []
            resolved = [resolve_member(i, ctx)[0] for i in identifiers]
            carried.append(
                draft["scope"]["value"] == "household"
                and len(identifiers) == len(emails)
                and all(m is not None for m in resolved)
                and {m["email"] for m in resolved if m is not None} == set(emails)
            )
        if all(carried):
            return True
    text = "\n".join(
        [request.get("text", ""), *[t["answer"] for t in request.get("history", [])]]
    )
    named = set()
    for member in ctx["members"]:
        for alias in (
            member["id"],
            member["email"],
            member["name"],
            "我" if member["email"] == ctx["currentUserEmail"] else "",
        ):
            if not alias or resolve_member(alias, ctx)[0] != member:
                continue
            pattern = re.escape(alias)
            if alias.isascii():
                pattern = r"(?<![\w@])" + pattern + r"(?![\w@])"
            if re.search(pattern, text, re.IGNORECASE):
                named.add(member["email"])
    if len(named) == 1 and (
        re.search(r"跟|與|和|\bwith\b", text, re.IGNORECASE) or request.get("history")
    ):
        named.add(ctx["currentUserEmail"])
    return set(emails) <= named


def historical_shares(
    relation: JSON, amount: Any, emails: list[str], ctx: JSON
) -> tuple[JSON | None, str | None]:
    ratio = relation.get("splitRatio")
    if ratio is not None:
        if not safe_integer(amount, 1):
            return None, "invalid"
        if (
            not isinstance(ratio, dict)
            or not ratio
            or any(not safe_integer(value) for value in ratio.values())
        ):
            return None, "invalid"
        ratio = {email: int(value) for email, value in ratio.items()}
        total = sum(ratio.values())
        if not total:
            return None, "invalid"
        if any(int(amount) * value % total for value in ratio.values()):
            return None, "custom_required"
        # Historical shares permit zero; model-supplied ratio weights still require >0.
        relation = {
            "shares": {
                email: int(amount) * value // total for email, value in ratio.items()
            }
        }
    return split_shares(relation, amount, emails, ctx)
