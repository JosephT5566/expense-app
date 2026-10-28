"""Python validators for the portable TypeScript wire contract.

Wire validators do not coerce booleans, numeric strings or absent nullable fields.
Provider extraction separately allows narrowly scoped personal-field defaults.
The browser uses packages/semantic-entry-contract; parity is covered by tests.
"""

import json
import math
import re
import unicodedata
from datetime import date, datetime
from typing import Any

JSON = dict[str, Any]
MAX_SAFE_INTEGER = 2**53 - 1
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
# ECMAScript String.trim whitespace, rather than Python's broader str.strip.
JS_SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def load_json(value: str | bytes) -> Any:
    # Python accepts NaN/Infinity by default; JSON.parse and the wire protocol do not.
    def invalid_constant(constant: str) -> Any:
        raise ValueError("Invalid JSON number")

    return json.loads(value, parse_constant=invalid_constant)


def load_provider_json(text: str) -> JSON:
    def pairs(items: list[tuple[str, Any]]) -> JSON:
        result: JSON = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    def invalid(value: str) -> Any:
        raise ValueError("Invalid JSON number")

    return object_(json.loads(text, object_pairs_hook=pairs, parse_constant=invalid))


def parse_provider_envelope(raw: object) -> JSON:
    # normalize imports the portable validators above; defer this import.
    from .normalize import parse_extraction

    value = object_(raw)
    exact_keys(value, ["analysis", "extraction"])
    analysis = string(value["analysis"])
    if len(analysis) > 200 or any(0xD800 <= ord(c) <= 0xDFFF for c in analysis):
        raise ValueError("Invalid analysis")
    return {"analysis": analysis, "extraction": parse_extraction(value["extraction"])}


def trim(value: str) -> str:
    return value.strip(JS_SPACE)


def object_(value: Any) -> JSON:
    if not isinstance(value, dict):
        raise ValueError("Invalid object")
    return value


def exact_keys(value: JSON, keys: list[str], optional: list[str] | None = None) -> None:
    if not set(keys) <= value.keys() or not value.keys() <= set(
        keys + (optional or [])
    ):
        raise ValueError("Invalid keys")


def string(value: Any) -> str:
    if not isinstance(value, str) or not trim(value):
        raise ValueError("Invalid string")
    return value


def request_id(value: Any) -> str:
    if not UUID.fullmatch(string(value)):
        raise ValueError("Invalid UUID")
    return value


def safe_integer(value: Any, minimum: int = 0) -> bool:
    return (
        type(value) in (int, float)
        and minimum <= value <= MAX_SAFE_INTEGER
        and math.isfinite(value)
        and value == int(value)
    )


def bounded_text(raw: Any, maximum: int) -> str:
    value = trim(string(raw))
    if len(value) > maximum:
        raise ValueError("Text too long")
    return unicodedata.normalize("NFC", value)


def date_only(value: Any) -> str:
    s = string(value)
    parsed = date.fromisoformat(s)
    if parsed.isoformat() != s or parsed.year < 100:
        raise ValueError("Invalid date")
    return s


def parse_request(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(r, ["requestId", "text"], ["history", "referenceDate"])
    parsed: JSON = {
        "requestId": request_id(r["requestId"]),
        "text": bounded_text(r["text"], 500),
    }
    if "referenceDate" in r:
        parsed["referenceDate"] = date_only(r["referenceDate"])
    if "history" in r:
        if not isinstance(r["history"], list) or len(r["history"]) > 3:
            raise ValueError("Invalid history")
        history = []
        for raw_turn in r["history"]:
            turn = object_(raw_turn)
            exact_keys(turn, ["question", "answer"])
            history.append(
                {
                    "question": bounded_text(turn["question"], 300),
                    "answer": bounded_text(turn["answer"], 500),
                }
            )
        if history:
            parsed["history"] = history
    return parsed


def timestamp(value: Any) -> str:
    s = string(value)
    if not re.match(r"\d{4}-\d{2}-\d{2}T", s):
        raise ValueError("Invalid timestamp")
    datetime.fromisoformat(s.replace("Z", "+00:00"))
    return s


def parse_expense_row(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(
        r,
        [
            "id",
            "payer_email",
            "note",
            "amount",
            "currency",
            "ts",
            "scope",
            "shares_json",
            "meta",
            "created_at",
            "updated_at",
            "is_settled",
        ],
        ["notes", "category_id"],
    )
    shares = object_(r["shares_json"])
    if not shares or any(
        "@" not in email or not safe_integer(v) for email, v in shares.items()
    ):
        raise ValueError("Invalid shares")
    if (
        r["currency"] != "TWD"
        or r["scope"] not in ("personal", "household")
        or type(r["is_settled"]) is not bool
        or not isinstance(r["meta"], str)
    ):
        raise ValueError("Invalid expense")
    request_id(r["id"])
    string(r["note"])
    string(r["payer_email"])
    if not safe_integer(r["amount"], 1) or sum(shares.values()) != r["amount"]:
        raise ValueError("Invalid amount/share sum")
    for key in ("ts", "created_at", "updated_at"):
        timestamp(r[key])
    if "notes" in r and not isinstance(r["notes"], str):
        raise ValueError("Invalid notes")
    if r.get("category_id") is not None:
        string(r["category_id"])
    return r


def parse_completed_result(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(r, ["expense", "replayed"])
    if type(r["replayed"]) is not bool:
        raise ValueError("Invalid replay flag")
    return {"expense": parse_expense_row(r["expense"]), "replayed": r["replayed"]}


# Parallel V3 validators. Completeness and caller/context authorization are service concerns.
MAX_REQUEST_BYTES_V3 = 65536
MAX_DRAFTS = 20
MAX_IMAGES = 4
MAX_IMAGE_PATH_LENGTH = 1024
DRAFT_FIELDS = (
    "note",
    "amount",
    "currency",
    "date",
    "categoryId",
    "scope",
    "payerEmail",
    "splitMemberEmails",
)
DRAFT_CODES = (
    "missing",
    "unrecognized",
    "low_confidence",
    "missing_confidence",
    "date_defaulted",
    "non_twd",
    "invalid",
    "unknown_member",
    "not_equal_split",
    "future_date",
)
ISSUE_CODES = (
    "missing",
    "invalid",
    "unknown_member",
    "ambiguous_member",
    "unsupported",
    "configuration",
)


def load_json_v3(value: str | bytes) -> JSON:
    parsed = load_provider_json(value.decode() if isinstance(value, bytes) else value)

    def finite(raw: Any) -> None:
        if isinstance(raw, float) and not math.isfinite(raw):
            raise ValueError("Invalid JSON number")
        if isinstance(raw, dict):
            for item in raw.values():
                finite(item)
        elif isinstance(raw, list):
            for item in raw:
                finite(item)

    finite(parsed)
    return parsed


def list_v3(raw: Any, maximum: int, parser: Any, minimum: int = 1) -> list[Any]:
    if not isinstance(raw, list) or not minimum <= len(raw) <= maximum:
        raise ValueError("Invalid list")
    return [parser(item) for item in raw]


def text_v3(raw: Any, maximum: int) -> str:
    value = bounded_text(raw, maximum)
    if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("Invalid Unicode")
    return value


def email_v3(raw: Any) -> str:
    value = text_v3(raw, 320)
    if not re.fullmatch(r"[^" + JS_SPACE + r"@]+@[^" + JS_SPACE + r"@]+", value):
        raise ValueError("Invalid email")
    return value


def currency_v3(raw: Any) -> str:
    if not isinstance(raw, str) or not re.fullmatch(r"[A-Z]{3}", raw):
        raise ValueError("Invalid currency")
    return raw


def draft_issues_v3(raw: Any) -> list[JSON]:
    if not isinstance(raw, list):
        raise ValueError("Invalid issues")
    result = []
    for item in raw:
        i = object_(item)
        exact_keys(i, ["field", "code"])
        if i["field"] not in DRAFT_FIELDS or i["code"] not in DRAFT_CODES:
            raise ValueError("Invalid draft issue")
        result.append({"field": i["field"], "code": i["code"]})
    return result


def parse_draft_v3(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(
        r,
        ["draftId", *DRAFT_FIELDS, "status", "issues"],
        ["mergedFrom", "originalAmount", "updated"],
    )
    result: JSON = {"draftId": request_id(r["draftId"])}
    if "mergedFrom" in r:
        result["mergedFrom"] = list_v3(r["mergedFrom"], MAX_DRAFTS, request_id)
    for key in DRAFT_FIELDS:
        f = object_(r[key])
        exact_keys(
            f,
            [
                "value",
                "state",
                "confidence",
                "source",
                *(["defaulted"] if key == "date" else []),
            ],
        )
        if f["state"] not in (
            "recognized",
            "unrecognized",
            "missing",
            "explicit_null",
        ) or f["source"] not in ("image", "text", "default", "user"):
            raise ValueError("Invalid field")
        confidence = f["confidence"]
        if confidence is not None and (
            type(confidence) not in (int, float)
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            raise ValueError("Invalid confidence")
        value = f["value"]
        if f["state"] == "explicit_null" and value is not None:
            raise ValueError("Invalid explicit null")
        if value is not None:
            if key == "amount":
                if not safe_integer(value, 1):
                    raise ValueError("Invalid amount")
                value = int(value)
            elif key == "date":
                value = date_only(value)
            elif key == "currency":
                value = currency_v3(value)
            elif key == "payerEmail":
                value = email_v3(value)
            elif key == "splitMemberEmails":
                value = list_v3(value, MAX_SAFE_INTEGER, email_v3, 0)
            elif key == "scope":
                if value not in ("personal", "household"):
                    raise ValueError("Invalid scope")
            else:
                value = text_v3(value, 200 if key == "note" else 1024)
        field = {
            "value": value,
            "state": f["state"],
            "confidence": confidence,
            "source": f["source"],
        }
        if key == "date":
            if f["defaulted"] not in (None, "unreadable", "future"):
                raise ValueError("Invalid default")
            field["defaulted"] = f["defaulted"]
        result[key] = field
    if "originalAmount" in r:
        original = r["originalAmount"]
        if original is not None:
            original = object_(original)
            exact_keys(original, ["text", "currency"])
            original = {
                "text": text_v3(original["text"], 200),
                "currency": currency_v3(original["currency"]),
            }
        result["originalAmount"] = original
    if r["status"] not in ("complete", "incomplete"):
        raise ValueError("Invalid draft status")
    result["status"] = r["status"]
    result["issues"] = draft_issues_v3(r["issues"])
    if "updated" in r:
        if type(r["updated"]) is not bool:
            raise ValueError("Invalid updated")
        result["updated"] = r["updated"]
    return result


def parse_request_v3(raw: Any) -> JSON:
    r = object_(raw)
    action = r.get("action")
    if action not in ("analyze", "revise", "commit"):
        raise ValueError("Invalid action")
    image = action == "analyze" and "images" in r
    required = (
        ["drafts"]
        if action == "commit"
        else ["images"]
        if image
        else ["text", "drafts"]
        if action == "revise"
        else ["text"]
    )
    exact_keys(
        r,
        ["requestId", "action", *required],
        [
            "referenceDate",
            *(["text"] if image else [] if action == "commit" else ["history"]),
        ],
    )
    result: JSON = {"requestId": request_id(r["requestId"]), "action": action}
    if "text" in r:
        result["text"] = (
            ""
            if image and isinstance(r["text"], str) and not trim(r["text"])
            else text_v3(r["text"], 500)
        )
    if "history" in r:
        history = parse_request(
            {
                "requestId": result["requestId"],
                "text": "history",
                "history": r["history"],
            }
        ).get("history")
        if history:
            result["history"] = [
                {
                    "question": text_v3(turn["question"], 300),
                    "answer": text_v3(turn["answer"], 500),
                }
                for turn in history
            ]
    if "referenceDate" in r:
        result["referenceDate"] = date_only(r["referenceDate"])
    if image:

        def path(raw: Any) -> str:
            value = text_v3(raw, MAX_IMAGE_PATH_LENGTH)
            if value != raw or ".." in value:
                raise ValueError("Invalid image path")
            return value

        result["images"] = list_v3(r["images"], MAX_IMAGES, path)
    if "drafts" in r:
        result["drafts"] = list_v3(r["drafts"], MAX_DRAFTS, parse_draft_v3)
    return result


def metadata_v3(raw: Any) -> JSON:
    m = object_(raw)
    exact_keys(
        m, ["model", "promptVersion", "inputTokens", "outputTokens", "elapsedMs"]
    )
    string(m["model"])
    string(m["promptVersion"])
    if not safe_integer(m["elapsedMs"]) or any(
        m[k] is not None and not safe_integer(m[k])
        for k in ("inputTokens", "outputTokens")
    ):
        raise ValueError("Invalid metadata")
    return m


def issues_v3(raw: Any, extended: bool = True) -> list[JSON]:
    def issue(raw: Any) -> JSON:
        i = object_(raw)
        exact_keys(i, ["field", "code"])
        if i["code"] not in (
            *ISSUE_CODES,
            *(("not_a_receipt", "too_many_drafts") if extended else ()),
        ):
            raise ValueError("Invalid issue")
        return {"field": string(i["field"]), "code": i["code"]}

    return list_v3(raw, MAX_SAFE_INTEGER, issue)


def parse_response_v3(raw: Any) -> JSON:
    r = object_(raw)
    result: JSON = {
        "status": r.get("status"),
        "requestId": request_id(r.get("requestId")),
    }
    if r.get("status") == "created":
        exact_keys(r, ["status", "requestId", "expenses", "replayed", "metadata"])
        if type(r["replayed"]) is not bool:
            raise ValueError("Invalid replay")
        result.update(
            expenses=list_v3(r["expenses"], MAX_DRAFTS, parse_expense_row),
            replayed=r["replayed"],
            metadata=None if r["metadata"] is None else metadata_v3(r["metadata"]),
        )
    elif r.get("status") == "drafts":
        exact_keys(r, ["status", "requestId", "drafts", "reason", "metadata"])
        if r["reason"] not in ("multiple", "incomplete"):
            raise ValueError("Invalid reason")
        result.update(
            drafts=list_v3(r["drafts"], MAX_DRAFTS, parse_draft_v3),
            reason=r["reason"],
            metadata=metadata_v3(r["metadata"]),
        )
    elif r.get("status") == "needs_input":
        exact_keys(r, ["status", "requestId", "question", "issues"])
        result.update(
            question=bounded_text(r["question"], 300),
            issues=issues_v3(r["issues"], False),
        )
    elif r.get("status") == "rejected":
        exact_keys(r, ["status", "requestId", "issues"], ["draftIssues"])
        result["issues"] = issues_v3(r["issues"])
        if "draftIssues" in r:

            def item(raw: Any) -> JSON:
                i = object_(raw)
                exact_keys(i, ["draftId", "issues"])
                issues = draft_issues_v3(i["issues"])
                if not issues:
                    raise ValueError("Empty issues")
                return {"draftId": request_id(i["draftId"]), "issues": issues}

            result["draftIssues"] = list_v3(r["draftIssues"], MAX_DRAFTS, item)
    else:
        raise ValueError("Invalid status")
    return result


def parse_status_response_v3(raw: Any) -> JSON:
    r = object_(raw)
    identifier = request_id(r.get("requestId"))
    if r.get("status") == "not_found":
        exact_keys(r, ["status", "requestId"])
        return {"status": "not_found", "requestId": identifier}
    exact_keys(r, ["status", "requestId", "expenses", "replayed"])
    if r["status"] != "completed" or r["replayed"] is not True:
        raise ValueError("Invalid completed")
    return {
        "status": "completed",
        "requestId": identifier,
        "expenses": list_v3(r["expenses"], MAX_DRAFTS, parse_expense_row),
        "replayed": True,
    }


def parse_stream_event_v3(event: str, raw: Any) -> JSON:
    r = object_(raw)
    if event == "result":
        return {"type": "result", "result": parse_response_v3(r)}
    if event == "analysis_delta":
        exact_keys(r, ["requestId", "seq", "text"])
        text = r["text"]
        if (
            not isinstance(text, str)
            or not 1 <= len(text) <= 200
            or any(0xD800 <= ord(c) <= 0xDFFF for c in text)
            or not safe_integer(r["seq"])
        ):
            raise ValueError("Invalid analysis")
        return {
            "type": event,
            "requestId": request_id(r["requestId"]),
            "seq": r["seq"],
            "text": text,
        }
    if event == "persisting":
        exact_keys(r, ["status", "requestId"])
        if r["status"] != "persisting":
            raise ValueError("Invalid persisting")
        return {"type": event, "requestId": request_id(r["requestId"])}
    if event == "error":
        exact_keys(r, ["error"])
        e = object_(r["error"])
        exact_keys(e, ["code", "uncertain"])
        if type(e["uncertain"]) is not bool:
            raise ValueError("Invalid uncertainty")
        return {"type": event, "code": string(e["code"]), "uncertain": e["uncertain"]}
    raise ValueError("Unknown stream event")
