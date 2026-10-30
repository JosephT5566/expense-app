import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import pytest

from semantic_entry.evaluation import receipt_main, run_receipt_evaluation

CASES = json.loads((Path(__file__).parents[1] / "evals/receipt-cases.json").read_text())


def test_all_receipt_fixtures():
    assert len(CASES) >= 14
    result = run_receipt_evaluation(CASES, 3)
    assert result["paidCalls"] == 0
    assert result["summary"] == {
        "observations": len(CASES) * 3,
        "passed": len(CASES) * 3,
        "failures": 0,
    }
    assert all(o["passed"] for o in result["observations"])


def test_multi_item_receipt_becomes_three_drafts_not_direct_commit():
    case = next(c for c in CASES if c["id"] == "multi-item-receipt")
    assert case["imageCount"] == 1 and len(case["raw"]["drafts"]) == 3
    result = run_receipt_evaluation([case])["observations"][0]["result"]
    assert result["status"] == "drafts"
    drafts = result["drafts"]
    assert [d["status"] for d in drafts] == ["complete"] * 3
    assert [d["values"]["note"] for d in drafts] == [
        "唐揚雞塊",
        "味玉魚介鹽味拉麵",
        "胡麻紅油擔擔拉麵",
    ]
    assert [d["values"]["amount"] for d in drafts] == [150, 330, 380]
    assert sum(d["values"]["amount"] for d in drafts) == 860
    for key in ("currency", "date", "scope", "payerEmail", "splitMemberEmails"):
        assert len({repr(d["values"][key]) for d in drafts}) == 1


def test_single_item_complete_receipt_still_commits_directly():
    case = next(c for c in CASES if c["id"] == "single-complete")
    result = run_receipt_evaluation([case])["observations"][0]["result"]
    assert result["status"] == "created" and len(result["drafts"]) == 1
    assert result["drafts"][0]["expense"] is not None


def test_expectation_mismatch_counts_as_failure():
    cases = deepcopy(CASES[:1])
    cases[0]["expected"]["drafts"][0]["values"]["amount"] = 999
    assert run_receipt_evaluation(cases)["summary"]["failures"] == 1


def test_prompt_injection_cannot_add_category_or_member():
    case = next(c for c in CASES if c["id"] == "prompt-injection")
    result = run_receipt_evaluation([case])["observations"][0]["result"]
    draft = result["drafts"][0]
    assert result["status"] == "drafts" and draft["status"] == "incomplete"
    assert (
        draft["values"]["categoryId"] is None and draft["values"]["payerEmail"] is None
    )
    assert {"field": "payerEmail", "code": "unknown_member"} in draft["issues"]
    assert draft["expense"] is None


def test_receipt_cli_writes_artifacts_and_exits_zero(tmp_path):
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "semantic_entry.evaluation",
            "--mode",
            "fixture",
            "--suite",
            "receipt",
            "--out",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout)["failures"] == 0
    assert (
        json.loads((tmp_path / "manifest.json").read_text())["caseSuite"] == "receipt"
    )
    assert (
        len(json.loads((tmp_path / "observations.json").read_text())) == len(CASES) * 3
    )


async def test_receipt_suite_rejects_live_before_environment_access(tmp_path):
    from argparse import Namespace

    with pytest.raises(ValueError, match="only supports fixture"):
        await receipt_main(Namespace(mode="live", out=tmp_path))
    assert list(tmp_path.iterdir()) == []


def test_receipt_cli_nonzero_for_mismatch(tmp_path):
    from argparse import Namespace
    from unittest.mock import patch

    cases = deepcopy(CASES[:1])
    cases[0]["expected"]["status"] = "drafts"
    with patch(
        "semantic_entry.evaluation.Path.read_bytes",
        return_value=json.dumps(cases).encode(),
    ):
        import asyncio

        with pytest.raises(SystemExit) as exc:
            asyncio.run(
                receipt_main(
                    Namespace(mode="fixture", out=tmp_path, runs=1, max_calls=120)
                )
            )
    assert exc.value.code == 1
