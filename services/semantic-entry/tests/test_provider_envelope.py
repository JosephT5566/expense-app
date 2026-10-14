import json

import pytest
from conftest import CONTEXT, RAW

from semantic_entry.contracts import load_provider_json, parse_provider_envelope
from semantic_entry.normalize import normalize_extraction


@pytest.mark.parametrize(
    "omitted",
    [
        ("payerId",),
        ("scope",),
        ("splitMemberIds",),
        ("payerId", "scope", "splitMemberIds"),
    ],
)
def test_omitted_personal_fields_default_to_callers_expense(omitted):
    raw = {
        k: v
        for k, v in {**RAW, "note": "午餐麥當勞", "amount": 500}.items()
        if k not in omitted
    }
    parsed = parse_provider_envelope(
        {"analysis": "今天午餐500麥當勞。", "extraction": raw}
    )
    result = normalize_extraction(parsed["extraction"], CONTEXT)
    assert result["status"] == "valid"
    assert result["expense"]["payer_email"] == "a@example.test"
    assert result["expense"]["scope"] == "personal"
    assert result["expense"]["shares_json"] == {"a@example.test": 500}
    assert result["expense"]["is_settled"] is True
    assert all(k not in raw for k in omitted)


@pytest.mark.parametrize("patch", [{"hasSharedIntent": True}, {"scope": "household"}])
def test_shared_intent_does_not_default_missing_personal_fields(patch):
    raw = {k: v for k, v in {**RAW, **patch}.items() if k != "splitMemberIds"}
    with pytest.raises(ValueError):
        parse_provider_envelope(
            {"analysis": "共同午餐，分攤對象不明。", "extraction": raw}
        )


@pytest.mark.parametrize("payer", ["b", "__unknown__", "__ambiguous__"])
def test_personal_defaults_preserve_explicit_payer(payer):
    raw = {k: v for k, v in {**RAW, "payerId": payer}.items() if k != "splitMemberIds"}
    parsed = parse_provider_envelope(
        {"analysis": "已辨識午餐支出。", "extraction": raw}
    )
    assert parsed["extraction"]["payerId"] == payer
    assert normalize_extraction(parsed["extraction"], CONTEXT)["status"] == "rejected"


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
