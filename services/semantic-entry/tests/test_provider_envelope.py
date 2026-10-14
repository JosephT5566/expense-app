import json

import pytest
from conftest import RAW

from semantic_entry.contracts import load_provider_json, parse_provider_envelope


def test_envelope_preserves_nullable_extraction():
    for raw in (RAW, {**RAW, "amount": None}):
        assert (
            parse_provider_envelope(
                {"analysis": "已辨識午餐支出。", "extraction": raw}
            )["extraction"]
            == raw
        )


@pytest.mark.parametrize("analysis", ["", " ", None, 42, "字" * 201, "🍜" * 201])
def test_envelope_rejects_invalid_analysis(analysis):
    with pytest.raises(ValueError):
        parse_provider_envelope({"analysis": analysis, "extraction": RAW})


def test_envelope_rejects_extra_decision_and_duplicate_keys():
    with pytest.raises(ValueError):
        parse_provider_envelope(
            {"analysis": "午餐", "extraction": RAW, "decision": "ready"}
        )
    for text in (
        '{"analysis":"a","analysis":"b","extraction":{}}',
        '{"analysis":"a","extraction":{"amount":1,"amount":2}}',
        '{"analysis":NaN,"extraction":{}}',
    ):
        with pytest.raises(ValueError):
            load_provider_json(text)


def test_envelope_counts_unicode_code_points():
    raw = load_provider_json(json.dumps({"analysis": "🍜" * 200, "extraction": RAW}))
    assert parse_provider_envelope(raw)["analysis"] == "🍜" * 200
