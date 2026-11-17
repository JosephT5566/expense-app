"""Rule-selected questions rebuilt from caller-scoped context on every turn."""

import json
import math
import re
import unicodedata
from copy import deepcopy
from fractions import Fraction
from itertools import combinations
from uuid import NAMESPACE_URL, uuid5

from .contracts import JSON
from .normalize import equal_shares, resolve_member, split_shares
from .same_split import historical_shares

QUESTIONS = {
    "amount": "這筆支出的台幣總金額是多少？請提供 1 到 9,999,999,999 元之間的整數。",
    "note": "這筆支出是買了什麼或支付什麼費用？",
    "date": "這筆支出實際發生在哪一天？請提供今天、昨天，或完整的年月日。",
    "payerId": "這筆支出由誰付款？個人支出只能記錄你自己的付款。",
    "members": "請選擇尚未確認的付款人或分攤成員。",
    "splitMemberIds": "請選擇要一起分攤的成員。",
    "categoryId": "這筆支出屬於哪個既有分類？",
    "currency": "目前只支援台幣支出。你能提供實際支付的台幣金額嗎？不能由我換算匯率。",
    "shares": "請確認每人的整數分攤金額。",
}
ENTITY_FIELDS = ("payerId", "members", "splitMemberIds", "categoryId")


def entity_options(field: str, context: JSON, page: int = 0) -> list[JSON]:
    key = "categories" if field == "categoryId" else "members"
    items = context.get(key, [])
    start = page * 3 if field == "categoryId" else 0
    remaining = items[start:]
    visible = (
        remaining[:3] if field == "categoryId" and len(remaining) > 4 else remaining[:4]
    )
    # Keep complete labels in the 300-character numbered fallback, including hints.
    labels = [
        unicodedata.normalize("NFC", " ".join(item["name"].split()))[:60]
        or item["id"][:60]
        for item in visible
    ]
    used = {label.casefold() for label in labels}
    options = []
    for index, (item, label) in enumerate(zip(visible, labels, strict=True)):
        if sum(other.casefold() == label.casefold() for other in labels) > 1:
            serial = index + 1
            while True:
                hint = f" ({item.get('email', item['id'])[:36]} #{serial})"
                candidate = label[: 60 - len(hint)] + hint
                if candidate.casefold() not in used:
                    label = candidate
                    break
                serial += 1
        used.add(label.casefold())
        options.append({"id": item["id"], "label": label})
    if field == "categoryId" and len(remaining) > 4:
        options.append({"id": f"category-page:{page + 1}", "label": "其他分類"})
    return options


def split_options(split: JSON, context: JSON) -> list[JSON]:
    emails = split["emails"]
    amount = split["amount"]
    names = {
        m["email"]: unicodedata.normalize("NFC", " ".join(m["name"].split()))
        for m in context["members"]
    }

    def label(shares: JSON, budget: int = 80) -> str:
        budget = min(budget, 48 if len(shares) == 2 else 80)
        part_budget = (budget - len(shares) + 1) // len(shares)
        return "、".join(
            f"{names[e][: max(1, part_budget - len(str(v)) - 3)]} {v} 元"
            for e, v in shares.items()
        )

    equal = equal_shares(amount, emails)
    options = [
        {
            "id": "equal",
            "label": "平均分攤：" + label(equal, 43 if len(emails) == 2 else 75),
        }
    ]
    difference = split.get("difference")
    if (
        len(emails) == 2
        and isinstance(difference, (int, float))
        and not isinstance(difference, bool)
        and math.isfinite(difference)
    ):
        caller = context["currentUserEmail"]
        if caller in emails:
            other = next(e for e in emails if e != caller)
            target = (Fraction(amount) + Fraction(str(difference))) / 2
            for own in (math.ceil(target), math.floor(target)):
                if 0 <= own <= amount:
                    identifier = f"split:{own}:{amount - own}"
                    if not any(o["id"] == identifier for o in options):
                        options.append(
                            {
                                "id": identifier,
                                "label": label({caller: own, other: amount - own}),
                            }
                        )
    historical = split.get("historicalShares")
    if historical is not None:
        binding = json.dumps([historical, split["historicalRelation"]], sort_keys=True)
        options.insert(
            1,
            {
                "id": "history:" + str(uuid5(NAMESPACE_URL, binding)),
                "label": "沿用上次分攤：" + label(historical, 70),
            },
        )
    options.append({"id": "custom", "label": "我來指定每人金額"})
    return [{**o, "label": o["label"][:80]} for o in options[:4]]


def contextual_question(field: str, context: JSON, split: JSON | None = None) -> str:
    question = QUESTIONS[field]
    if field == "date":
        baseline = context.get("referenceDate", context.get("today"))
        if baseline:
            question = f"這筆支出實際發生在哪一天？本次「今天」固定為 {baseline}（台灣日期）；也可提供完整年月日。"
    if field == "shares" and split is not None:
        difference = split.get("difference")
        question = f"總額 {int(split['amount'])} 元"
        if (
            isinstance(difference, (int, float))
            and not isinstance(difference, bool)
            and math.isfinite(difference)
        ):
            difference_text = (
                str(int(difference))
                if difference == int(difference)
                else repr(difference)
            )
            question += f"；你的金額比另一位多 {difference_text} 元"
        question += "。請確認每人的整數分攤金額。"
    return question


def make_question(
    field: str,
    request: JSON,
    context: JSON,
    *,
    turn: int | None = None,
    split: JSON | None = None,
) -> JSON:
    index = len(request.get("history", [])) if turn is None else turn
    page = 0
    for previous_index, previous in enumerate(request.get("history", [])[:index]):
        identifier = previous.get("optionId", "")
        if not identifier and field == "categoryId":
            prior = make_question(field, request, context, turn=previous_index)
            if prior["question"] == previous["question"]:
                identifier = next(
                    (
                        o["id"]
                        for number, o in enumerate(prior["options"], 1)
                        if previous["answer"] in (str(number), o["label"])
                    ),
                    "",
                )
        if identifier == f"category-page:{page + 1}":
            page += 1
    options = (
        entity_options(field, context, page)
        if field in ENTITY_FIELDS
        else split_options(split, context)
        if field == "shares" and split
        else []
    )
    question = contextual_question(field, context, split)
    if field == "categoryId" and page:
        question += f"（第 {page + 1} 頁）"
    if options:
        # Four labels of at most 80 characters must also fit the legacy 300-character question.
        budget = max(1, (300 - len(question) - 20) // len(options))
        question += "\n" + "\n".join(
            f"{i + 1}. {o['label'][:budget]}" for i, o in enumerate(options)
        )
    binding = json.dumps(
        [
            request["requestId"],
            request.get("referenceDate"),
            index,
            field,
            question,
            options,
        ],
        ensure_ascii=False,
        sort_keys=True,
    )
    return {
        "questionId": str(uuid5(NAMESPACE_URL, binding)),
        "question": question,
        "options": options,
        "allowFreeText": not bool(options),
        "purpose": "category"
        if field == "categoryId"
        else "payer"
        if field == "payerId"
        else "split"
        if field == "shares"
        else "member"
        if field in ENTITY_FIELDS
        else field,
    }


def clarification_result(
    validation: JSON, request: JSON, context: JSON | None = None
) -> JSON:
    issues = validation["issues"]
    repairable = bool(issues) and all(
        i["field"] in QUESTIONS and i["code"] != "configuration" for i in issues
    )
    if repairable and len(request.get("history", [])) < 3:
        # Identity must be settled before offering monetary split interpretations.
        first = next(
            (
                i
                for i in issues
                if i["field"] in ("payerId", "members", "splitMemberIds")
            ),
            issues[0],
        )
        if (
            first["field"] in ("payerId", "members", "splitMemberIds")
            and len(entity_options(first["field"], context or {})) == 1
        ):
            return {
                "status": "rejected",
                "requestId": request["requestId"],
                "issues": issues,
            }
        return {
            "status": "needs_input",
            "requestId": request["requestId"],
            "issues": issues,
            **make_question(
                first["field"],
                request,
                context or {},
                split=validation.get("splitContext"),
            ),
        }
    return {"status": "rejected", "requestId": request["requestId"], "issues": issues}


def split_context(raw: JSON, context: JSON, question: str = "") -> JSON | None:
    ids = raw.get("splitMemberIds") or []
    emails = []
    for identifier in ids:
        member, _ = resolve_member(identifier, context)
        if member is not None and member["email"] not in emails:
            emails.append(member["email"])
    amount = raw.get("amount")
    if (
        not isinstance(amount, (int, float))
        or isinstance(amount, bool)
        or not math.isfinite(amount)
        or amount <= 0
        or int(amount) != amount
        or len(emails) < 2
    ):
        return None
    difference = raw.get("splitDifference")
    if difference is None:
        match = re.search(
            r"你的金額比另一位多 (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?) 元", question
        )
        if match:
            difference = float(match[1])
    return {"amount": int(amount), "emails": sorted(emails), "difference": difference}


def apply_answers(
    raw: JSON, request: JSON, context: JSON, *, historical: JSON | None = None
) -> tuple[JSON, bool, bool]:
    """Validate option IDs against fresh options; apply trusted IDs without model guessing.

    UUIDs bind a question to its request, turn and current option list, without a
    checkpointer. They are correlation IDs; authorization comes from fresh context.
    """
    result = deepcopy(raw)
    custom = False
    for index, turn in enumerate(request.get("history", [])):
        structured = "optionId" in turn
        matched = False
        candidates: list[tuple[str, JSON | None]] = [
            (field, None) for field in ENTITY_FIELDS
        ]
        original_split = split_context(result, context, turn["question"])
        if historical is not None:
            candidates.append(("shares", historical))
        if original_split is not None:
            candidates.append(("shares", original_split))
        # Monetary data can be restated by a client, but participants must come
        # from fresh context. Rebuild prior split questions independently of the
        # model's latest interpretation, which may already include the answer.
        total = re.match(r"總額 (\d+) 元", turn["question"])
        difference_match = re.search(
            r"你的金額比另一位多 (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?) 元",
            turn["question"],
        )
        if total:
            emails = sorted({m["email"] for m in context["members"][:4]})
            for count in range(2, len(emails) + 1):
                for participants in combinations(emails, count):
                    candidates.append(
                        (
                            "shares",
                            {
                                "amount": int(total[1]),
                                "emails": list(participants),
                                "difference": float(difference_match[1])
                                if difference_match
                                else None,
                            },
                        )
                    )
        for field, split in candidates:
            expected = make_question(field, request, context, turn=index, split=split)
            if expected["question"] != turn["question"]:
                continue
            if structured:
                if expected["questionId"] != turn.get("questionId"):
                    continue
                chosen = next(
                    (o for o in expected["options"] if o["id"] == turn["optionId"]),
                    None,
                )
                if chosen is None or chosen["label"] != turn["answer"]:
                    return result, False, False
            else:
                chosen = next(
                    (
                        o
                        for number, o in enumerate(expected["options"], 1)
                        if not o["id"].startswith("history:")
                        and turn["answer"] in (str(number), o["label"])
                    ),
                    None,
                )
                if chosen is None:
                    continue
            matched = True
            if field == "categoryId":
                result["categoryId"] = (
                    None if chosen["id"].startswith("category-page:") else chosen["id"]
                )
            elif field == "payerId":
                previous_payer = result.get("payerId")
                result["payerId"] = chosen["id"]
                # A failed explicitly named payer may also appear in the split.
                ids = result.get("splitMemberIds")
                if (
                    ids
                    and previous_payer
                    and resolve_member(previous_payer, context)[0] is None
                ):
                    result["splitMemberIds"] = [
                        chosen["id"] if i == previous_payer else i for i in ids
                    ]
            elif field in ("members", "splitMemberIds"):
                ids = result.get("splitMemberIds") or []
                unresolved = next(
                    (i for i in ids if resolve_member(i, context)[0] is None), None
                )
                for key in ("shares", "splitRatio"):
                    values = result.get(key)
                    if not isinstance(values, dict):
                        continue
                    candidate = unresolved or next(
                        (i for i in values if resolve_member(i, context)[0] is None),
                        None,
                    )
                    if candidate in values:
                        # Preserve the exact amount/weight; only the trusted
                        # identity changes. Collisions remain invalid to normalize.
                        if chosen["id"] in values and candidate != chosen["id"]:
                            return result, False, False
                        result[key] = {
                            chosen["id"] if i == candidate else i: value
                            for i, value in values.items()
                        }
                        unresolved = candidate
                resolved = []
                replaced = False
                for identifier in ids:
                    member, _ = resolve_member(identifier, context)
                    if member:
                        resolved.append(member["id"])
                    elif not replaced:
                        resolved.append(chosen["id"])
                        replaced = True
                    else:
                        resolved.append(identifier)
                if not resolved:
                    caller, _ = resolve_member(context["currentUserEmail"], context)
                    resolved = (
                        [caller["id"], chosen["id"]] if caller else [chosen["id"]]
                    )
                elif not replaced and chosen["id"] not in resolved:
                    resolved.append(chosen["id"])
                result["splitMemberIds"] = list(dict.fromkeys(resolved))
            else:
                assert split is not None
                emails = split["emails"]
                amount = result.get("amount")
                identifier = chosen["id"]
                result.update(
                    splitMemberIds=emails,
                    scope="household",
                    hasSharedIntent=True,
                    shares=None,
                    splitDifference=None,
                    splitRatio=None,
                )
                if identifier.startswith("history:"):
                    assert historical is not None
                    shares, code = historical_shares(
                        historical["historicalRelation"], amount, emails, context
                    )
                    result["shares"] = shares if not code else {}
                elif identifier in ("custom", "equal"):
                    if (
                        isinstance(amount, (int, float))
                        and math.isfinite(amount)
                        and amount > 0
                        and int(amount) == amount
                    ):
                        result["shares"] = equal_shares(int(amount), emails)
                    custom = identifier == "custom"
                else:
                    _, own, other = identifier.split(":")
                    # Apply the confirmed relation to every receipt item, without
                    # rounding an item whose total has different parity.
                    result["splitDifference"] = int(own) - int(other)
                    shares, code = split_shares(result, amount, emails, context)
                    if not code:
                        result.update(shares=shares, splitDifference=None)
                if result.get("unsupportedReason") in (
                    "unequal_split",
                    "custom_split",
                    "non_equal_split",
                ):
                    result["unsupportedReason"] = None
            break
        if structured and not matched:
            return result, False, False
    # A sole category is unambiguous. An explicit unresolved payer must never
    # silently become the caller, even when that is the only allowed member.
    options = entity_options("categoryId", context)
    if len(options) == 1 and not any(
        c["id"] == result.get("categoryId") for c in context["categories"]
    ):
        result["categoryId"] = options[0]["id"]
    return result, True, custom


def historical_confirmed(request: JSON, context: JSON, split: JSON) -> bool:
    """Only an answer to the freshly rebuilt monetary question confirms a relation."""
    for index, turn in enumerate(request.get("history", [])):
        expected = make_question("shares", request, context, turn=index, split=split)
        if turn["question"] != expected["question"]:
            continue
        for number, option in enumerate(expected["options"], 1):
            if "optionId" in turn:
                if (
                    turn.get("questionId") == expected["questionId"]
                    and turn["optionId"] == option["id"]
                    and turn["answer"] == option["label"]
                ):
                    return True
            elif not option["id"].startswith("history:") and turn["answer"] in (
                str(number),
                option["label"],
            ):
                return True
    return False
