from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_stack.py"


def load_check_stack():
    spec = importlib.util.spec_from_file_location("intime_check_stack", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["intime_check_stack"] = module
    spec.loader.exec_module(module)
    return module


cs = load_check_stack()


def test_required_fail_sets_nonzero_exit() -> None:
    results = [
        cs.CheckResult("backend-ready", cs.FAIL, "HTTP 503", required=True),
        cs.CheckResult("llm-live", cs.WARN, "connection refused", required=False),
    ]
    assert cs.exit_code(results) == 1


def test_optional_problems_keep_zero_exit() -> None:
    results = [
        cs.CheckResult("backend-ready", cs.PASS, "ok", required=True),
        cs.CheckResult("litellm", cs.WARN, "restarting", required=False),
        cs.CheckResult("stt", cs.SKIP, "не задан", required=False),
    ]
    assert cs.exit_code(results) == 0


def test_missing_required_container_is_fail() -> None:
    result = cs.docker_service_check("db", None, required=True)
    assert result.status == cs.FAIL
    assert result.required is True
    assert "не найден" in result.detail


def test_missing_optional_container_is_skip() -> None:
    result = cs.docker_service_check("litellm", None, required=False)
    assert result.status == cs.SKIP
    assert result.required is False


def test_restarting_required_container_is_fail() -> None:
    info = cs.ContainerInfo(
        service="backend",
        name="intime-backend-1",
        state="running",
        health="starting",
        restarting=True,
    )
    result = cs.docker_service_check("backend", info, required=True)
    assert result.status == cs.FAIL
    assert "restarting" in result.detail


def test_unhealthy_optional_container_is_warn() -> None:
    info = cs.ContainerInfo(
        service="litellm",
        name="intime-litellm-1",
        state="running",
        health="unhealthy",
        restarting=False,
    )
    result = cs.docker_service_check("litellm", info, required=False)
    assert result.status == cs.WARN
    assert cs.exit_code([result]) == 0


def test_running_healthy_container_is_pass() -> None:
    info = cs.ContainerInfo(
        service="db",
        name="intime-db-1",
        state="running",
        health="healthy",
        restarting=False,
    )
    result = cs.docker_service_check("db", info, required=True)
    assert result.status == cs.PASS


def test_report_names_failed_component() -> None:
    report = cs.format_report(
        [cs.CheckResult("backend-ready", cs.FAIL, "HTTP 503 database unavailable", required=True)]
    )
    assert "FAIL" in report
    assert "backend-ready" in report
    assert "database unavailable" in report
    assert "обязательные компоненты с ошибкой" in report


def test_redact_hides_secrets_and_url_userinfo() -> None:
    hidden = cs.redact("token=sk-live-secret and more", ("sk-live-secret",))
    assert "sk-live-secret" not in hidden
    assert "***" in hidden
    assert cs.safe_url("http://user:p@ss@127.0.0.1:4000/v1") == "http://127.0.0.1:4000/v1"


def test_redact_does_not_eat_compose_service_names() -> None:
    text = cs.redact("intime-litellm-1 running", ("litellm", "sk-live-secret"))
    assert "intime-litellm-1" in text
    assert cs._should_redact_value("litellm") is False
    assert cs._should_redact_value("sk-live-secret") is True


def test_rewrite_host_docker_internal_for_host_client() -> None:
    url = cs.rewrite_url_for_host("http://host.docker.internal:4000/v1")
    assert url == "http://127.0.0.1:4000/v1"


def test_parse_env_file_ignores_comments(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("# comment\nLLM_API_KEY=sk-abcd1234\n\nPOSTGRES_USER=intime\n", encoding="utf-8")
    values = cs.parse_env_file(path)
    assert values["LLM_API_KEY"] == "sk-abcd1234"
    assert "comment" not in values
    secrets = cs.secret_values(values)
    assert "sk-abcd1234" in secrets


def test_readiness_ok_requires_status_and_json() -> None:
    assert cs.readiness_ok(200, '{"status":"ok","database":"ok"}')
    assert not cs.readiness_ok(503, '{"status":"error","database":"unavailable"}')
    assert not cs.readiness_ok(200, "<html>ok</html>")


def test_parse_container_status_detects_unhealthy() -> None:
    state, health, restarting = cs.parse_container_status("running", "Up 3 seconds (unhealthy)")
    assert state == "running"
    assert health == "unhealthy"
    assert restarting is False
    state, health, restarting = cs.parse_container_status("restarting", "Restarting (1) 2 seconds ago")
    assert restarting is True


def test_main_nonzero_when_required_http_fails(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  db:\n    image: postgres:16-alpine\n", encoding="utf-8")

    def fake_http(url: str, timeout: float, headers: dict[str, str] | None = None) -> cs.HttpFetch:
        if url.endswith("/api/v1/live"):
            return cs.HttpFetch(status=None, body="", error="нет соединения (ConnectionRefusedError)")
        return cs.HttpFetch(status=None, body="", error="нет соединения (ConnectionRefusedError)")

    monkeypatch.setattr(cs, "resolve_compose", lambda timeout: None)
    monkeypatch.setattr(cs, "docker_available", lambda timeout: False)
    monkeypatch.setattr(cs, "http_get", fake_http)
    monkeypatch.setattr(cs, "tcp_open", lambda host, port, timeout: "ConnectionRefusedError")

    code = cs.main(
        [
            "--project-dir",
            str(tmp_path),
            "--compose-file",
            str(compose_file),
            "--backend-url",
            "http://127.0.0.1:8010",
            "--frontend-url",
            "http://127.0.0.1:3010",
            "--timeout",
            "1",
        ]
    )
    assert code == 1


def test_main_zero_when_core_passes_and_llm_warns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  db:\n    image: postgres:16-alpine\n", encoding="utf-8")
    (tmp_path / ".env").write_text(
        "LLM_API_KEY=sk-test-secret-key\nLLM_BASE_URL=http://127.0.0.1:4000/v1\nLLM_MODEL=qwen3-32b\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LLM_API_KEY", "sk-test-secret-key")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:4000/v1")
    monkeypatch.setenv("LLM_MODEL", "qwen3-32b")

    def fake_http(url: str, timeout: float, headers: dict[str, str] | None = None) -> cs.HttpFetch:
        if url.endswith("/api/v1/live"):
            return cs.HttpFetch(status=200, body='{"status":"ok"}', error="")
        if url.endswith("/api/v1/health") or url.endswith("/api/health"):
            return cs.HttpFetch(status=200, body='{"status":"ok","database":"ok"}', error="")
        if url.endswith("/static/lib/api.js") or url.endswith(".css") or url.endswith(".js"):
            return cs.HttpFetch(status=200, body="ok", error="")
        if url.rstrip("/").endswith(":3010"):
            return cs.HttpFetch(status=200, body="<html>InTime</html>", error="")
        return cs.HttpFetch(status=None, body="", error="нет соединения (ConnectionRefusedError)")

    monkeypatch.setattr(cs, "resolve_compose", lambda timeout: None)
    monkeypatch.setattr(cs, "docker_available", lambda timeout: False)
    monkeypatch.setattr(cs, "http_get", fake_http)
    monkeypatch.setattr(cs, "tcp_open", lambda host, port, timeout: None)

    code = cs.main(
        [
            "--deep",
            "--project-dir",
            str(tmp_path),
            "--compose-file",
            str(compose_file),
            "--backend-url",
            "http://127.0.0.1:8010",
            "--frontend-url",
            "http://127.0.0.1:3010",
            "--timeout",
            "1",
        ]
    )
    captured = capsys.readouterr()
    assert code == 0
    assert "sk-test-secret-key" not in captured.out
    assert "llm-live" in captured.out
    assert "WARN" in captured.out
