"""Python validators for the portable TypeScript wire contract.

No coercion of booleans, numeric strings or absent nullable fields. The browser
continues to use packages/semantic-entry-contract; parity is covered by tests.
"""

import json
import math
import re
import unicodedata
from datetime import datetime
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


def parse_request(raw: Any) -> JSON:
    r = object_(raw)
    exact_keys(r, ["requestId", "text"])
    text = trim(string(r["text"]))
    if len(text) > 500:
        raise ValueError("Text too long")
    return {
        "requestId": request_id(r["requestId"]),
        "text": unicodedata.normalize("NFC", text),
    }


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
