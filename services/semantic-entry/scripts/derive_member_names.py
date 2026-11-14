"""Derive runtime member names from public display configuration without logging it."""

import json
import re


def derive_member_names(raw: str) -> dict[str, str]:
    try:
        mapping = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError("Invalid PUBLIC_EMAIL_NAME_MAPPING JSON") from None
    if not isinstance(mapping, dict):
        raise ValueError("PUBLIC_EMAIL_NAME_MAPPING must be an email-to-object map")
    names: dict[str, str] = {}
    for email, info in mapping.items():
        if (
            not isinstance(email, str)
            or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) is None
            or not isinstance(info, dict)
            or not isinstance(info.get("name"), str)
            or not info["name"].strip()
        ):
            raise ValueError(
                "PUBLIC_EMAIL_NAME_MAPPING requires email keys and non-empty name strings"
            )
        names[email] = info["name"]
    return names
