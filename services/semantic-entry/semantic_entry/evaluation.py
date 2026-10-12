"""Bounded synthetic/live evaluation; never creates expenses or accesses Supabase."""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .contracts import JSON
from .normalize import normalize_extraction
from .prompt import PROMPT_VERSION

COMMON = ("note", "amount", "currency", "scope", "category_id")
DERIVED = ("ts", "payer_email", "shares_json", "is_settled")


def score_case(expected: JSON, raw: Any, result: JSON) -> JSON:
    r = raw if isinstance(raw, dict) else {}
    amount = r.get("amount")
    baseline = (
        isinstance(r.get("note"), str)
        and bool(r["note"].strip())
        and isinstance(amount, (int, float))
        and not isinstance(amount, bool)
        and math.isfinite(amount)
        and amount > 0
    )
    proposal = {**r, "category_id": r.get("categoryId")}
    actual = result["expense"] if result["status"] == "valid" else {}
    fields = expected["fields"] if expected["status"] == "valid" else {}
    common = [k for k in COMMON if k in fields]
    derived = [k for k in DERIVED if k in fields]

    def issues(items: list[JSON]) -> list[str]:
        return sorted(f"{i['field']}:{i['code']}" for i in items)

    return {
        "expectedEligible": expected["status"] == "valid",
        "baselineEligible": baseline,
        "harnessEligible": result["status"] == "valid",
        "baselineFields": sum(
            k in proposal and proposal[k] == fields[k] for k in common
        ),
        "harnessFields": sum(k in actual and actual[k] == fields[k] for k in common),
        "commonFields": len(common),
        "derivedFields": sum(k in actual and actual[k] == fields[k] for k in derived),
        "derivedTotal": len(derived),
        "rejectionCorrect": expected["status"] == "rejected"
        and result["status"] == "rejected"
        and issues(expected["issues"]) == issues(result["issues"]),
        "inputTokens": None,
        "outputTokens": None,
        "elapsedMs": None,
    }


def metric(n: int, d: int) -> JSON:
    return {"numerator": n, "denominator": d, "value": n / d if d else None}


def summarize(scores: list[JSON]) -> JSON:
    quality = [s for s in scores if not s.get("error")]
    eligible = sum(s["expectedEligible"] for s in quality)

    def evaluate(key: str, field: str) -> JSON:
        predicted = [s for s in quality if s[key]]
        tp = sum(s["expectedEligible"] for s in predicted)
        return {
            "precision": metric(tp, len(predicted)),
            "recall": metric(tp, eligible),
            "fieldAccuracy": metric(
                sum(s[field] for s in quality), sum(s["commonFields"] for s in quality)
            ),
        }

    rejected = [s for s in quality if not s["expectedEligible"]]
    invalid = [s for s in rejected if s["baselineEligible"]]

    def usage(key: str) -> int | None:
        return (
            sum(s[key] for s in scores)
            if all(s[key] is not None for s in scores)
            else None
        )

    times = sorted(s["elapsedMs"] for s in scores if s["elapsedMs"] is not None)

    def percentile(p: float) -> float | None:
        return times[max(0, math.ceil(p * len(times)) - 1)] if times else None

    return {
        "observations": len(scores),
        "qualityObservations": len(quality),
        "failures": len(scores) - len(quality),
        "baseline": evaluate("baselineEligible", "baselineFields"),
        "harness": evaluate("harnessEligible", "harnessFields"),
        "derivedFieldAccuracy": metric(
            sum(s["derivedFields"] for s in quality),
            sum(s["derivedTotal"] for s in quality),
        ),
        "rejectionCorrect": metric(
            sum(s["rejectionCorrect"] for s in rejected), len(rejected)
        ),
        "invalidPayloadBlocked": metric(
            sum(not s["harnessEligible"] for s in invalid), len(invalid)
        ),
        "usage": {
            "inputTokens": usage("inputTokens"),
            "outputTokens": usage("outputTokens"),
            "knownInputObservations": sum(s["inputTokens"] is not None for s in scores),
            "knownOutputObservations": sum(
                s["outputTokens"] is not None for s in scores
            ),
        },
        "latency": {
            "samples": len(times),
            "p50Ms": percentile(0.5),
            "p95Ms": percentile(0.95),
        },
    }


def estimate_cost(usage: JSON, pricing: JSON) -> float | None:
    for key in ("inputUsdPerMillion", "outputUsdPerMillion"):
        value = pricing[key]
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("Invalid pricing")
    if any(
        v is None
        for v in (
            usage["inputTokens"],
            usage["outputTokens"],
            pricing["inputUsdPerMillion"],
            pricing["outputUsdPerMillion"],
        )
    ):
        return None
    return (
        usage["inputTokens"] * pricing["inputUsdPerMillion"]
        + usage["outputTokens"] * pricing["outputUsdPerMillion"]
    ) / 1_000_000


def validate_options(mode: str, runs: int, max_calls: int, count: int) -> None:
    if (
        mode not in ("fixture", "live")
        or type(runs) is not int
        or runs < 1
        or type(max_calls) is not int
        or not 1 <= max_calls <= 120
        or count * runs > max_calls
    ):
        raise ValueError(
            "Evaluation requires fixture/live mode and at most 120 observations/calls"
        )


async def run_evaluation(
    mode: str, runs: int, max_calls: int, cases: list[JSON], provider: Any = None
) -> JSON:
    validate_options(mode, runs, max_calls, len(cases))
    if len({c["id"] for c in cases}) != len(cases) or any(
        not c.get("id")
        or not c.get("text")
        or not c.get("context")
        or c.get("expected", {}).get("status") not in ("valid", "rejected")
        for c in cases
    ):
        raise ValueError("Invalid evaluation cases")
    if mode == "live" and provider is None:
        raise ValueError("Live provider required")
    observations = []
    paid_calls = 0
    for case in cases:
        for run in range(1, runs + 1):
            start = time.monotonic()
            raw = case["raw"]
            extracted: JSON = {}
            error = None
            try:
                if mode == "live":
                    paid_calls += 1
                    extracted = await provider(case["text"], case["context"])
                    raw = extracted["raw"]
                result = normalize_extraction(raw, case["context"])
            except Exception:
                error = "provider_error"
                raw = None
                result = {"status": "rejected", "issues": []}
            score = {
                **score_case(case["expected"], raw, result),
                "inputTokens": extracted.get("inputTokens"),
                "outputTokens": extracted.get("outputTokens"),
                "elapsedMs": (time.monotonic() - start) * 1000,
            }
            if error:
                score["error"] = error
            observations.append(
                {
                    "id": case["id"],
                    "group": case["group"],
                    "run": run,
                    "raw": raw,
                    "result": result,
                    "score": score,
                }
            )
    return {
        "observations": observations,
        "paidCalls": paid_calls,
        "summary": summarize([o["score"] for o in observations]),
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("fixture", "live"), default="fixture")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--max-calls", type=int, default=120)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    root = (await asyncio.to_thread(Path(__file__).resolve)).parent.parent
    case_text = (root / "evals/cases.json").read_text()
    cases = json.loads(case_text)
    validate_options(args.mode, args.runs, args.max_calls, len(cases))

    def price(name: str) -> float | None:
        return float(os.environ[name]) if os.environ.get(name) else None

    pricing = {
        "inputUsdPerMillion": price("SEMANTIC_INPUT_USD_PER_MILLION"),
        "outputUsdPerMillion": price("SEMANTIC_OUTPUT_USD_PER_MILLION"),
        "source": os.environ.get("SEMANTIC_PRICING_SOURCE"),
        "asOf": os.environ.get("SEMANTIC_PRICING_AS_OF"),
    }
    if (
        pricing["inputUsdPerMillion"] is not None
        or pricing["outputUsdPerMillion"] is not None
    ) and (not pricing["source"] or not pricing["asOf"]):
        raise ValueError("Record pricing source and date")
    estimate_cost({"inputTokens": None, "outputTokens": None}, pricing)
    if args.mode == "fixture":
        result = await run_evaluation(args.mode, args.runs, args.max_calls, cases)
    else:
        import httpx

        from .provider import Provider

        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError("Live evaluation requires OPENAI_API_KEY")
        async with httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(retries=0)
        ) as client:
            provider = Provider(
                client,
                os.environ["OPENAI_API_KEY"],
                os.environ.get("SEMANTIC_MODEL", "gpt-5.4-mini"),
            )
            result = await run_evaluation(
                args.mode, args.runs, args.max_calls, cases, provider
            )
    now = datetime.now(UTC).isoformat()
    manifest = {
        "mode": args.mode,
        "runs": args.runs,
        "maxCalls": args.max_calls,
        "gitSha": (
            await asyncio.to_thread(
                subprocess.check_output,
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                text=True,
            )
        ).strip(),
        "caseHash": hashlib.sha256(case_text.encode()).hexdigest(),
        "date": now,
        "python": platform.python_version(),
        "versions": {
            p: importlib.metadata.version(p)
            for p in ("httpx", "langgraph", "starlette", "uvicorn")
        },
        "promptVersion": PROMPT_VERSION,
        "model": os.environ.get("SEMANTIC_MODEL", "gpt-5.4-mini")
        if args.mode == "live"
        else "fixture",
        "paidCalls": result["paidCalls"],
        "pricing": pricing,
        "estimatedCostUsd": estimate_cost(result["summary"]["usage"], pricing),
        "costNote": "Recorded pricing assumptions only; unknown usage or price stays null. Estimates are not bills.",
        "methodology": "Both projections share the same raw output and five common fields. Baseline requires nonempty note and positive finite amount. Derived fields are harness-only. Provider failures excluded from quality denominators. Fixture runs do not measure model quality.",
    }
    out = args.out or root / "evals/runs" / now.replace(":", "-")
    out.mkdir(parents=True, exist_ok=True)
    for name, data in (
        ("manifest", manifest),
        ("summary", result["summary"]),
        ("observations", result["observations"]),
    ):
        (out / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        )
    print(
        json.dumps(
            {
                "out": str(out),
                "caseIds": len(cases),
                "observations": len(result["observations"]),
                "paidCalls": result["paidCalls"],
                "failures": result["summary"]["failures"],
            }
        )
    )
    if result["summary"]["failures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
