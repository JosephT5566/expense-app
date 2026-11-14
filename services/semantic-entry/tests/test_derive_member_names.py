"""Deployment configuration is tested with synthetic fixtures, never live vars."""

import json
import runpy
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts" / "derive_member_names.py"
derive_member_names = runpy.run_path(str(SCRIPT))["derive_member_names"]
FIXTURES = Path(__file__).parent / "fixtures" / "member-names"


def test_valid_mapping_ignores_color_and_does_not_print(capsys):
    raw = (FIXTURES / "valid.json").read_text()
    assert derive_member_names(raw) == {
        "a@example.test": "合成甲",
        "b@example.test": "lionheart",
    }
    assert derive_member_names("{}") == {}
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize(
    "raw",
    [
        '{"a@example.test":"private-synthetic-value",',
        (FIXTURES / "array.json").read_text(),
        (FIXTURES / "missing-name.json").read_text(),
        json.dumps({"not-an-email": {"name": "private-synthetic-value"}}),
        json.dumps({"a@example.test": "private-synthetic-value"}),
        json.dumps({"a@example.test": {"name": " "}}),
        json.dumps({"a@example.test": {"name": 7}}),
        json.dumps({"a@example.test": ["private-synthetic-value"]}),
        "null",
    ],
)
def test_invalid_configuration_fails_without_echoing_values(raw, capsys):
    with pytest.raises(ValueError, match="PUBLIC_EMAIL_NAME_MAPPING") as error:
        derive_member_names(raw)
    assert "a@example.test" not in str(error.value)
    assert "private-synthetic-value" not in str(error.value)
    assert raw not in str(error.value)
    assert capsys.readouterr() == ("", "")


def test_deploy_uses_single_source_and_shared_parser():
    workflow = (
        Path(__file__).parents[3] / ".github/workflows/semantic-entry-deploy.yml"
    ).read_text()
    assert "vars.PUBLIC_EMAIL_NAME_MAPPING" in workflow
    assert "vars.SEMANTIC_MEMBER_NAMES" not in workflow
    assert "derive_member_names.py" in workflow
    assert "derive_member_names(os.environ['PUBLIC_EMAIL_NAME_MAPPING'])" in workflow


@pytest.mark.parametrize("valid", [True, False])
def test_release_validation_writes_runtime_without_logging_mapping(tmp_path, valid):
    import subprocess
    import sys

    root = Path(__file__).parents[3]
    workflow = (root / ".github/workflows/semantic-entry-deploy.yml").read_text()
    source = workflow.split("python3 - <<'PY'\n", 1)[1].split(
        "                  PY\n", 1
    )[0]
    source = "\n".join(
        line.removeprefix("                  ") for line in source.splitlines()
    )
    raw = (FIXTURES / ("valid.json" if valid else "missing-name.json")).read_text()
    result = subprocess.run(
        [sys.executable, "-c", source],
        cwd=root,
        env={
            "GCP_PROJECT_ID": "synthetic-project",
            "GCP_REGION": "asia-east1",
            "GCP_ARTIFACT_REPOSITORY": "synthetic",
            "GCP_CLOUD_RUN_SERVICE": "synthetic-service",
            "GCP_DEPLOY_SERVICE_ACCOUNT": "deploy@synthetic-project.iam.gserviceaccount.com",
            "GCP_RUNTIME_SERVICE_ACCOUNT": "runtime@synthetic-project.iam.gserviceaccount.com",
            "GCP_WORKLOAD_IDENTITY_PROVIDER": "projects/123/locations/global/workloadIdentityPools/synthetic/providers/synthetic",
            "SEMANTIC_MODEL": "gemini-3.5-flash-lite",
            "SEMANTIC_GEMINI_SECRET": "synthetic-model-key:1",
            "SEMANTIC_UPLOAD_BUCKET": "synthetic-receipts",
            "SEMANTIC_ALLOWED_ORIGINS": "https://frontend.example.test",
            "SUPABASE_URL": "https://supabase.example.test",
            "SUPABASE_PUBLISHABLE_KEY": "synthetic-publishable-key",
            "PUBLIC_EMAIL_NAME_MAPPING": raw,
            "RUNNER_TEMP": str(tmp_path),
            "GITHUB_ENV": str(tmp_path / "github-output"),
            "GITHUB_SHA": "a" * 40,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert "a@example.test" not in result.stdout + result.stderr
    assert "lionheart" not in result.stdout + result.stderr
    assert raw not in result.stdout + result.stderr
    runtime_path = tmp_path / "semantic-runtime.json"
    if valid:
        assert result.returncode == 0, result.stderr
        runtime = json.loads(runtime_path.read_text())
        assert json.loads(runtime["SEMANTIC_MEMBER_NAMES"]) == {
            "a@example.test": "合成甲",
            "b@example.test": "lionheart",
        }
        assert "PUBLIC_EMAIL_NAME_MAPPING" not in runtime
        assert result.stdout == result.stderr == ""
    else:
        assert result.returncode != 0
        assert "PUBLIC_EMAIL_NAME_MAPPING" in result.stderr
        assert not runtime_path.exists()
