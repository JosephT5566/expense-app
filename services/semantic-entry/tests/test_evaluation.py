import json
from collections import Counter
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from conftest import CONTEXT, RAW

from semantic_entry.evaluation import (
    estimate_cost,
    run_evaluation,
    score_case,
    summarize,
    validate_options,
)
from semantic_entry.normalize import normalize_extraction

CASES = json.loads((Path(__file__).parents[1] / "evals/cases.json").read_text())
VALID = {
    "status": "valid",
    "fields": {
        "note": "午餐",
        "amount": 851,
        "currency": "TWD",
        "scope": "personal",
        "category_id": CONTEXT["categories"][0]["id"],
    },
}
REJECTED = {
    "status": "rejected",
    "issues": [{"field": "currency", "code": "unsupported"}],
}


def test_denominators():
    bad = {**RAW, "currency": "USD"}
    missing = {**RAW, "amount": None}
    summary = summarize(
        [
            score_case(e, r, normalize_extraction(r, CONTEXT))
            for e, r in [(VALID, RAW), (REJECTED, bad), (VALID, missing)]
        ]
    )
    assert summary["baseline"]["precision"] == {
        "numerator": 1,
        "denominator": 2,
        "value": 0.5,
    }
    assert summary["baseline"]["recall"]["value"] == 0.5
    assert summary["harness"]["precision"]["value"] == 1
    assert summary["harness"]["recall"]["value"] == 0.5
    assert summary["invalidPayloadBlocked"]["value"] == 1


def test_zero_eligible_unknown_usage_and_failure():
    raw = {**RAW, "amount": None, "currency": "USD"}
    summary = summarize([score_case(REJECTED, raw, normalize_extraction(raw, CONTEXT))])
    assert summary["baseline"]["precision"]["value"] is None
    assert (
        summary["usage"]["inputTokens"] is None
        and summary["usage"]["outputTokens"] is None
    )
    score = {
        **score_case(REJECTED, None, {"status": "rejected", "issues": []}),
        "error": "provider_error",
    }
    summary = summarize([score])
    assert summary["failures"] == 1 and summary["rejectionCorrect"]["denominator"] == 0


@pytest.mark.parametrize(
    "mode,runs,cap", [("live", 4, 120), ("live", 3, 121), ("bad", 1, 120)]
)
def test_bounded_calls(mode, runs, cap):
    with pytest.raises(ValueError):
        validate_options(mode, runs, cap, 40)


async def test_40_fixture_cases_no_network_or_write():
    assert len(CASES) == len({c["id"] for c in CASES}) == 40
    assert list(Counter(c["group"] for c in CASES).values()) == [5] * 8
    provider = AsyncMock(side_effect=RuntimeError("network must not run"))
    result = await run_evaluation("fixture", 3, 120, CASES, provider)
    assert len(result["observations"]) == 120 and result["paidCalls"] == 0
    provider.assert_not_awaited()
    assert result["summary"]["harness"]["precision"]["value"] == 1
    assert result["summary"]["harness"]["recall"]["value"] == 1
    assert result["summary"]["rejectionCorrect"]["value"] == 1


def test_cost():
    usage = {"inputTokens": 1000, "outputTokens": 500}
    pricing = {"inputUsdPerMillion": 2, "outputUsdPerMillion": 8}
    assert estimate_cost(usage, pricing) == 0.006
    assert estimate_cost({**usage, "inputTokens": None}, pricing) is None
    assert (
        estimate_cost(usage, {"inputUsdPerMillion": None, "outputUsdPerMillion": None})
        is None
    )
    with pytest.raises(ValueError):
        estimate_cost(usage, {**pricing, "inputUsdPerMillion": -1})
