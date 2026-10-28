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
