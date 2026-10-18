import json
import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts/baseline-db-test.sh"


@pytest.fixture
def docker_calls(tmp_path, monkeypatch):
    calls = tmp_path / "calls.jsonl"
    monkeypatch.setenv("BASELINE_TEST_CALLS", str(calls))
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    docker = tmp_path / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        + dedent("""
        import json
        import os
        import sys
        from pathlib import Path

        calls = Path(os.environ["BASELINE_TEST_CALLS"])
        args = sys.argv[1:]
        previous = calls.read_text().splitlines() if calls.exists() else []
        with calls.open("a") as output:
            output.write(json.dumps(args) + "\\n")
        if "pg_isready" in args:
            if os.environ.get("BASELINE_TEST_NEVER_READY"):
                sys.exit(1)
            probes = sum("pg_isready" in json.loads(line) for line in previous)
            sys.exit(0 if "127.0.0.1" not in args or probes >= 2 else 1)
        if "createdb" in args or "psql" in args:
            if "127.0.0.1" not in args:
                print("temporary server socket disappeared", file=sys.stderr)
                sys.exit(1)
            sys.stdin.read()
        if args[0] == "logs":
            print("synthetic initialization still pending")
        """)
    )
    docker.chmod(0o755)
    sleep = tmp_path / "sleep"
    sleep.write_text("#!/bin/sh\nexit 0\n")
    sleep.chmod(0o755)
    return calls


def test_baseline_waits_for_tcp_before_creating_database(docker_calls):
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in docker_calls.read_text().splitlines()]
    probes = [c for c in calls if "pg_isready" in c]
    assert len(probes) == 3
    assert all("127.0.0.1" in c for c in probes)
    assert any("createdb" in c for c in calls)
    assert any("psql" in c for c in calls)
    assert calls[-1][:2] == ["rm", "-f"]


def test_baseline_timeout_reports_logs_without_running_sql(docker_calls, monkeypatch):
    monkeypatch.setenv("BASELINE_TEST_NEVER_READY", "1")
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, timeout=10
    )
    assert result.returncode != 0
    calls = [json.loads(line) for line in docker_calls.read_text().splitlines()]
    assert len([c for c in calls if "pg_isready" in c]) == 30
    assert not any("createdb" in c or "psql" in c for c in calls)
    assert "PostgreSQL did not become ready" in result.stderr
    assert "synthetic initialization still pending" in result.stderr
    assert calls[-1][:2] == ["rm", "-f"]
