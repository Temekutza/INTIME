#!/usr/bin/env python3
"""Диагностика уже запущенного стека InTime. Только чтение, без inference."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

PASS = "PASS"
FAIL = "FAIL"
WARN = "WARN"
SKIP = "SKIP"

REQUIRED_COMPOSE = ("db", "backend")
OPTIONAL_COMPOSE = ("frontend", "litellm", "litellm-db", "litellm-docker")
DEFAULT_BACKEND_URL = "http://127.0.0.1:8010"
DEFAULT_FRONTEND_URL = "http://127.0.0.1:3010"
DEFAULT_DB_TCP = ("127.0.0.1", 5435)
FRONTEND_ASSETS = (
    "/static/styles.css",
    "/static/app.js",
    "/static/dashboard.js",
    "/static/lib/api.js",
)
SECRET_KEY_MARKERS = (
    "PASSWORD",
    "SECRET",
    "TOKEN",
    "API_KEY",
    "MASTER_KEY",
    "DATABASE_URL",
)
BODY_LIMIT = 160


@dataclass(frozen=True)
class CheckResult:
    component: str
    status: str
    detail: str
    required: bool = True


@dataclass(frozen=True)
class ContainerInfo:
    service: str
    name: str
    state: str
    health: str | None
    restarting: bool


@dataclass(frozen=True)
class HttpFetch:
    status: int | None
    body: str
    error: str


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def _should_redact_value(value: str) -> bool:
    if not value:
        return False
    if value.startswith("sk-") or "://" in value:
        return True
    if value in REQUIRED_COMPOSE or value in OPTIONAL_COMPOSE:
        return False
    return len(value) >= 8


def secret_values(env_map: Mapping[str, str]) -> tuple[str, ...]:
    found: list[str] = []
    for key, value in env_map.items():
        upper = key.upper()
        if not value or not any(marker in upper for marker in SECRET_KEY_MARKERS):
            continue
        if _should_redact_value(value):
            found.append(value)
    return tuple(found)


def redact(text: str, secrets: tuple[str, ...] = ()) -> str:
    cleaned = text
    for secret in sorted({item for item in secrets if item}, key=len, reverse=True):
        if _should_redact_value(secret):
            cleaned = cleaned.replace(secret, "***")
    return cleaned


def safe_url(url: str) -> str:
    parts = urlsplit(url)
    if not parts.hostname:
        return url
    host = parts.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))


def rewrite_url_for_host(url: str) -> str:
    """Адреса Docker DNS с хоста не резолвятся — подставляем loopback."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host != "host.docker.internal":
        return url
    hostname = "127.0.0.1"
    if parts.port:
        hostname = f"{hostname}:{parts.port}"
    return urlunsplit((parts.scheme, hostname, parts.path, parts.query, parts.fragment))


def env_get(file_vals: Mapping[str, str], key: str) -> str:
    return os.environ.get(key, file_vals.get(key, "")).strip()


def origin(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "", "", "")).rstrip("/")


def join_url(base: str, path: str) -> str:
    return origin(base) + path


def provider_root(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return base[:-3]
    return base


def exit_code(results: list[CheckResult]) -> int:
    if any(item.status == FAIL and item.required for item in results):
        return 1
    return 0


def format_report(results: list[CheckResult]) -> str:
    width = max((len(item.component) for item in results), default=8)
    lines = ["Проверка стека InTime", ""]
    for item in results:
        kind = "обяз." if item.required else "необяз."
        lines.append(f"{item.status:4}  {item.component:<{width}}  [{kind}]  {item.detail}")
    required_fail = [item.component for item in results if item.status == FAIL and item.required]
    optional_fail = [item.component for item in results if item.status == FAIL and not item.required]
    warns = [item.component for item in results if item.status == WARN]
    lines.append("")
    if required_fail:
        lines.append("Итог: обязательные компоненты с ошибкой: " + ", ".join(required_fail))
    elif optional_fail or warns:
        lines.append("Итог: ядро доступно, есть замечания по необязательным компонентам.")
    else:
        lines.append("Итог: обязательные проверки пройдены.")
    return "\n".join(lines)


def docker_service_check(
    service: str,
    info: ContainerInfo | None,
    *,
    required: bool,
) -> CheckResult:
    component = f"docker:{service}"
    if info is None:
        if required:
            return CheckResult(
                component,
                FAIL,
                "контейнер проекта не найден",
                required=True,
            )
        return CheckResult(
            component,
            SKIP,
            "сервис не запущен в этом Compose-проекте",
            required=False,
        )
    where = info.name
    if info.restarting or info.state == "restarting":
        status = FAIL if required else WARN
        return CheckResult(
            component,
            status,
            f"{where}: состояние restarting",
            required=required,
        )
    if info.state not in {"running", "up"}:
        status = FAIL if required else WARN
        return CheckResult(
            component,
            status,
            f"{where}: state={info.state}",
            required=required,
        )
    if info.health == "unhealthy":
        status = FAIL if required else WARN
        return CheckResult(
            component,
            status,
            f"{where}: Docker healthcheck = unhealthy",
            required=required,
        )
    if info.health == "starting":
        return CheckResult(
            component,
            WARN,
            f"{where}: healthcheck ещё starting",
            required=required,
        )
    health = info.health or "нет healthcheck"
    return CheckResult(
        component,
        PASS,
        f"{where}: running, {health}",
        required=required,
    )


def _run(
    args: list[str],
    timeout: float,
    cwd: Path | None = None,
    *,
    discard_stdout: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        stdout=subprocess.DEVNULL if discard_stdout else subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )


def resolve_compose(timeout: float) -> list[str] | None:
    candidates = (["docker", "compose"], ["docker-compose"])
    for command in candidates:
        try:
            proc = _run(command + ["version"], timeout=timeout)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0:
            return command
    return None


def docker_available(timeout: float) -> bool:
    try:
        proc = _run(["docker", "info"], timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def parse_container_status(state: str, status: str) -> tuple[str, str | None, bool]:
    state_l = state.strip().lower()
    status_l = status.strip().lower()
    restarting = "restarting" in state_l or "restarting" in status_l
    health: str | None = None
    if "unhealthy" in status_l:
        health = "unhealthy"
    elif "health: starting" in status_l or "(health: starting)" in status_l:
        health = "starting"
    elif "(starting)" in status_l and "health" in status_l:
        health = "starting"
    elif "healthy" in status_l:
        health = "healthy"
    return state_l, health, restarting


def list_project_containers(project: str, timeout: float) -> dict[str, ContainerInfo]:
    fmt = '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}\t{{.Names}}'
    proc = _run(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--format",
            fmt,
        ],
        timeout=timeout,
    )
    if proc.returncode != 0:
        return {}
    found: dict[str, ContainerInfo] = {}
    for raw in proc.stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        service, state, status, name = parts[0], parts[1], parts[2], parts[3]
        if not service:
            continue
        state_l, health, restarting = parse_container_status(state, status)
        found[service] = ContainerInfo(
            service=service,
            name=name,
            state=state_l,
            health=health,
            restarting=restarting,
        )
    return found


def compose_port(
    compose: list[str],
    compose_file: Path,
    root: Path,
    service: str,
    container_port: int,
    timeout: float,
) -> str | None:
    proc = _run(
        compose
        + [
            "-f",
            str(compose_file),
            "--project-directory",
            str(root),
            "port",
            service,
            str(container_port),
        ],
        timeout=timeout,
        cwd=root,
    )
    if proc.returncode != 0:
        return None
    hostport = proc.stdout.strip().splitlines()[0].strip() if proc.stdout.strip() else ""
    return hostport or None


def http_get(url: str, timeout: float, headers: dict[str, str] | None = None) -> HttpFetch:
    request = Request(url, method="GET", headers=headers or {})
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read(4096).decode("utf-8", errors="replace")
            return HttpFetch(status=getattr(response, "status", 200), body=body, error="")
    except HTTPError as exc:
        body = exc.read(4096).decode("utf-8", errors="replace") if exc.fp else ""
        return HttpFetch(status=exc.code, body=body, error="")
    except TimeoutError:
        return HttpFetch(status=None, body="", error="таймаут")
    except URLError as exc:
        reason = type(exc.reason).__name__ if exc.reason else type(exc).__name__
        return HttpFetch(status=None, body="", error=f"нет соединения ({reason})")
    except OSError as exc:
        return HttpFetch(status=None, body="", error=f"нет соединения ({type(exc).__name__})")


def snippet(body: str) -> str:
    text = " ".join(body.split())
    if len(text) <= BODY_LIMIT:
        return text
    return text[: BODY_LIMIT - 1] + "…"


def tcp_open(host: str, port: int, timeout: float) -> str | None:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return None
    except OSError as exc:
        return type(exc).__name__


def readiness_ok(status: int | None, body: str) -> bool:
    if status != 200:
        return False
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return False
    return (
        isinstance(payload, dict)
        and payload.get("status") == "ok"
        and payload.get("database") == "ok"
    )


def live_ok(status: int | None, body: str) -> bool:
    if status != 200:
        return False
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return False
    return isinstance(payload, dict) and payload.get("status") == "ok"


class Checker:
    def __init__(
        self,
        *,
        root: Path,
        compose_file: Path,
        project: str,
        timeout: float,
        deep: bool,
        backend_url: str,
        frontend_url: str,
        secrets: tuple[str, ...],
        compose: list[str] | None,
        containers: dict[str, ContainerInfo],
        docker_ok: bool,
        file_env: Mapping[str, str],
    ) -> None:
        self.root = root
        self.compose_file = compose_file
        self.project = project
        self.timeout = timeout
        self.deep = deep
        self.backend_url = backend_url.rstrip("/")
        self.frontend_url = frontend_url.rstrip("/")
        self.secrets = secrets
        self.compose = compose
        self.containers = containers
        self.docker_ok = docker_ok
        self.file_env = file_env
        self.results: list[CheckResult] = []

    def add(self, result: CheckResult) -> None:
        self.results.append(
            CheckResult(
                result.component,
                result.status,
                redact(result.detail, self.secrets),
                required=result.required,
            )
        )

    def env(self, key: str) -> str:
        return env_get(self.file_env, key)

    def compose_base(self) -> list[str]:
        assert self.compose is not None
        return self.compose + [
            "-f",
            str(self.compose_file),
            "--project-directory",
            str(self.root),
        ]

    def check_compose_config(self) -> None:
        if self.compose is None:
            self.add(
                CheckResult(
                    "compose-config",
                    WARN,
                    "Docker Compose CLI недоступен, файл не проверен",
                    required=False,
                )
            )
            return
        try:
            proc = _run(self.compose_base() + ["config", "--quiet"], timeout=self.timeout, cwd=self.root)
            if proc.returncode != 0:
                proc = _run(
                    self.compose_base() + ["config"],
                    timeout=self.timeout,
                    cwd=self.root,
                    discard_stdout=True,
                )
        except subprocess.TimeoutExpired:
            self.add(CheckResult("compose-config", FAIL, "docker compose config: таймаут"))
            return
        if proc.returncode == 0:
            self.add(
                CheckResult(
                    "compose-config",
                    PASS,
                    f"{self.compose_file.name} принят, проект {self.project}",
                )
            )
            return
        detail = redact((proc.stderr or "ошибка конфигурации").strip(), self.secrets)
        self.add(
            CheckResult(
                "compose-config",
                FAIL,
                f"docker compose config завершился с кодом {proc.returncode}: {snippet(detail)}",
            )
        )

    def check_containers(self) -> None:
        if not self.docker_ok:
            self.add(
                CheckResult(
                    "docker",
                    WARN,
                    "нет доступа к Docker; контейнеры не проверены, смотрите HTTP с хоста",
                    required=False,
                )
            )
            return
        for service in REQUIRED_COMPOSE:
            self.add(
                docker_service_check(service, self.containers.get(service), required=True)
            )
        for service in OPTIONAL_COMPOSE:
            self.add(
                docker_service_check(service, self.containers.get(service), required=False)
            )

    def check_postgres(self) -> None:
        db = self.containers.get("db")
        if self.compose is not None and db and db.state in {"running", "up"}:
            try:
                proc = _run(
                    self.compose_base()
                    + [
                        "exec",
                        "-T",
                        "db",
                        "sh",
                        "-c",
                        'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
                    ],
                    timeout=self.timeout,
                    cwd=self.root,
                )
            except subprocess.TimeoutExpired:
                self.add(CheckResult("postgres-ready", FAIL, "pg_isready: таймаут"))
            else:
                text = redact((proc.stdout or proc.stderr or "").strip(), self.secrets)
                if proc.returncode == 0:
                    self.add(CheckResult("postgres-ready", PASS, text or "принимает подключения"))
                else:
                    self.add(
                        CheckResult(
                            "postgres-ready",
                            FAIL,
                            f"pg_isready код {proc.returncode}: {snippet(text) or 'не готов'}",
                        )
                    )
        elif "db" in REQUIRED_COMPOSE and not db:
            self.add(
                CheckResult(
                    "postgres-ready",
                    SKIP,
                    "контейнер db недоступен, pg_isready пропущен",
                    required=False,
                )
            )

        host, port = DEFAULT_DB_TCP
        if self.compose is not None:
            published = compose_port(
                self.compose, self.compose_file, self.root, "db", 5432, self.timeout
            )
            if published and ":" in published:
                host, port_s = published.rsplit(":", 1)
                if port_s.isdigit():
                    port = int(port_s)
        error = tcp_open(host, port, self.timeout)
        if error is None:
            self.add(CheckResult("postgres-port", PASS, f"{host}:{port} принимает TCP"))
        else:
            self.add(
                CheckResult(
                    "postgres-port",
                    FAIL,
                    f"{host}:{port} недоступен с хоста ({error})",
                )
            )

    def check_backend_http(self) -> None:
        live_url = join_url(self.backend_url, "/api/v1/live")
        ready_url = join_url(self.backend_url, "/api/v1/health")
        live = http_get(live_url, self.timeout)
        if live_ok(live.status, live.body):
            self.add(CheckResult("backend-live", PASS, f"{safe_url(live_url)} HTTP 200"))
        elif live.status is None:
            self.add(
                CheckResult(
                    "backend-live",
                    FAIL,
                    f"{safe_url(live_url)} недоступен с хоста: {live.error}",
                )
            )
        else:
            self.add(
                CheckResult(
                    "backend-live",
                    FAIL,
                    f"{safe_url(live_url)} HTTP {live.status} {snippet(live.body)}",
                )
            )

        ready = http_get(ready_url, self.timeout)
        if readiness_ok(ready.status, ready.body):
            self.add(CheckResult("backend-ready", PASS, f"{safe_url(ready_url)} БД отвечает на SELECT 1"))
        elif ready.status is None:
            self.add(
                CheckResult(
                    "backend-ready",
                    FAIL,
                    f"{safe_url(ready_url)} недоступен с хоста: {ready.error}",
                )
            )
        else:
            self.add(
                CheckResult(
                    "backend-ready",
                    FAIL,
                    f"{safe_url(ready_url)} HTTP {ready.status} {snippet(ready.body)}",
                )
            )

    def check_frontend(self) -> None:
        page_url = join_url(self.frontend_url, "/")
        page = http_get(page_url, self.timeout)
        if page.status is None:
            self.add(
                CheckResult(
                    "frontend-http",
                    FAIL,
                    f"{safe_url(page_url)} недоступен с хоста: {page.error}",
                )
            )
        elif page.status != 200:
            self.add(
                CheckResult(
                    "frontend-http",
                    FAIL,
                    f"{safe_url(page_url)} HTTP {page.status}",
                )
            )
        else:
            self.add(CheckResult("frontend-http", PASS, f"{safe_url(page_url)} HTTP 200"))

        for path in FRONTEND_ASSETS:
            url = join_url(self.frontend_url, path)
            fetched = http_get(url, self.timeout)
            component = f"frontend-asset:{path}"
            if fetched.status == 200 and fetched.body.strip():
                self.add(CheckResult(component, PASS, "HTTP 200", required=True))
            elif fetched.status is None:
                self.add(
                    CheckResult(
                        component,
                        FAIL,
                        f"{safe_url(url)} недоступен с хоста: {fetched.error}",
                    )
                )
            else:
                self.add(
                    CheckResult(
                        component,
                        FAIL,
                        f"{safe_url(url)} HTTP {fetched.status}",
                    )
                )

        proxy_url = join_url(self.frontend_url, "/api/health")
        proxy = http_get(proxy_url, self.timeout)
        if readiness_ok(proxy.status, proxy.body):
            self.add(
                CheckResult(
                    "frontend-api-proxy",
                    PASS,
                    f"{safe_url(proxy_url)} nginx проксирует backend, БД готова",
                )
            )
        elif proxy.status is None:
            self.add(
                CheckResult(
                    "frontend-api-proxy",
                    FAIL,
                    f"{safe_url(proxy_url)} недоступен с хоста: {proxy.error}",
                )
            )
        else:
            self.add(
                CheckResult(
                    "frontend-api-proxy",
                    FAIL,
                    f"{safe_url(proxy_url)} HTTP {proxy.status} {snippet(proxy.body)}",
                )
            )

    def check_inter_container(self) -> None:
        frontend = self.containers.get("frontend")
        if self.compose is None or not frontend or frontend.state not in {"running", "up"}:
            self.add(
                CheckResult(
                    "backend-from-frontend",
                    SKIP,
                    "контейнер frontend не запущен, сеть Compose не проверялась",
                    required=False,
                )
            )
            return
        try:
            proc = _run(
                self.compose_base()
                + [
                    "exec",
                    "-T",
                    "frontend",
                    "wget",
                    "-q",
                    "-O",
                    "-",
                    "http://backend:8000/api/v1/health",
                ],
                timeout=self.timeout,
                cwd=self.root,
            )
        except subprocess.TimeoutExpired:
            self.add(
                CheckResult(
                    "backend-from-frontend",
                    FAIL,
                    "таймаут wget http://backend:8000/api/v1/health из контейнера frontend",
                )
            )
            return
        body = redact(proc.stdout.strip(), self.secrets)
        if proc.returncode == 0 and readiness_ok(200, body):
            self.add(
                CheckResult(
                    "backend-from-frontend",
                    PASS,
                    "из контейнера frontend backend:8000 отвечает ready",
                )
            )
            return
        err = redact((proc.stderr or "").strip(), self.secrets)
        self.add(
            CheckResult(
                "backend-from-frontend",
                FAIL,
                "backend недоступен из контейнера frontend "
                f"(код {proc.returncode}): {snippet(body or err) or 'пустой ответ'}",
            )
        )

    def check_deep(self) -> None:
        if not self.deep:
            self.add(
                CheckResult(
                    "integrations",
                    SKIP,
                    "расширенная проверка выключена; запуск: python3 scripts/check_stack.py --deep",
                    required=False,
                )
            )
            return
        self._check_llm()
        self._check_speech("STT", "STT_API_KEY", "STT_BASE_URL", "/audio/transcriptions")
        self._check_speech("TTS", "TTS_API_KEY", "TTS_BASE_URL", "/audio/speech")

    def _check_llm(self) -> None:
        key = self.env("LLM_API_KEY")
        base = self.env("LLM_BASE_URL")
        model = self.env("LLM_MODEL")
        if not key:
            self.add(
                CheckResult(
                    "llm-config",
                    SKIP,
                    "LLM_API_KEY пуст, ассистент выключен",
                    required=False,
                )
            )
            return
        if not base:
            self.add(
                CheckResult(
                    "llm-config",
                    WARN,
                    "LLM_API_KEY задан, но LLM_BASE_URL пуст",
                    required=False,
                )
            )
            return
        self.add(
            CheckResult(
                "llm-config",
                PASS,
                f"ключ задан, модель {model or 'не указана'}, {safe_url(rewrite_url_for_host(base))}",
                required=False,
            )
        )
        host_base = rewrite_url_for_host(base)
        live_url = provider_root(host_base).rstrip("/") + "/health/liveliness"
        live = http_get(live_url, self.timeout)
        if live.status == 200:
            self.add(
                CheckResult("llm-live", PASS, f"{safe_url(live_url)} HTTP 200", required=False)
            )
        elif live.status is None:
            self.add(
                CheckResult(
                    "llm-live",
                    WARN,
                    f"{safe_url(live_url)} недоступен с хоста: {live.error}",
                    required=False,
                )
            )
        else:
            self.add(
                CheckResult(
                    "llm-live",
                    WARN,
                    f"{safe_url(live_url)} HTTP {live.status} (для облачного провайдера это нормально)",
                    required=False,
                )
            )

        models_url = provider_root(host_base).rstrip("/") + "/v1/models"
        fetched = http_get(
            models_url,
            self.timeout,
            headers={"Authorization": f"Bearer {key}"},
        )
        if fetched.status in {401, 403}:
            self.add(
                CheckResult(
                    "llm-models",
                    WARN,
                    f"{safe_url(models_url)} HTTP {fetched.status}: ошибка авторизации",
                    required=False,
                )
            )
        elif fetched.status is None:
            self.add(
                CheckResult(
                    "llm-models",
                    WARN,
                    f"{safe_url(models_url)} недоступен с хоста: {fetched.error}",
                    required=False,
                )
            )
        elif fetched.status != 200:
            self.add(
                CheckResult(
                    "llm-models",
                    WARN,
                    f"{safe_url(models_url)} HTTP {fetched.status}",
                    required=False,
                )
            )
        else:
            detail = f"{safe_url(models_url)} HTTP 200"
            try:
                payload = json.loads(fetched.body)
            except json.JSONDecodeError:
                payload = None
            ids: list[str] = []
            if isinstance(payload, dict):
                rows = payload.get("data")
                if isinstance(rows, list):
                    ids = [
                        str(item.get("id"))
                        for item in rows
                        if isinstance(item, dict) and item.get("id")
                    ]
            if model and ids and model not in ids:
                self.add(
                    CheckResult(
                        "llm-models",
                        WARN,
                        f"{detail}, модель {model} не найдена",
                        required=False,
                    )
                )
            else:
                if model and ids:
                    detail = f"{detail}, модель {model} есть в списке"
                self.add(CheckResult("llm-models", PASS, detail, required=False))

        self._check_llm_from_backend(base)

    def _check_llm_from_backend(self, base: str) -> None:
        backend = self.containers.get("backend")
        if self.compose is None or not backend or backend.state not in {"running", "up"}:
            self.add(
                CheckResult(
                    "llm-from-backend",
                    SKIP,
                    "контейнер backend не запущен, путь host.docker.internal не проверен",
                    required=False,
                )
            )
            return
        live_path = provider_root(base).rstrip("/") + "/health/liveliness"
        code = (
            "import urllib.request; urllib.request.urlopen("
            f"{live_path!r}, timeout={max(1, int(self.timeout))})"
        )
        try:
            proc = _run(
                self.compose_base() + ["exec", "-T", "backend", "python", "-c", code],
                timeout=self.timeout + 2,
                cwd=self.root,
            )
        except subprocess.TimeoutExpired:
            self.add(
                CheckResult(
                    "llm-from-backend",
                    WARN,
                    f"таймаут запроса {safe_url(live_path)} из контейнера backend",
                    required=False,
                )
            )
            return
        if proc.returncode == 0:
            self.add(
                CheckResult(
                    "llm-from-backend",
                    PASS,
                    f"из backend доступен {safe_url(live_path)}",
                    required=False,
                )
            )
            return
        err = redact((proc.stderr or proc.stdout or "").strip(), self.secrets)
        self.add(
            CheckResult(
                "llm-from-backend",
                WARN,
                "шлюз недоступен из контейнера backend "
                f"({safe_url(live_path)}): {snippet(err) or f'код {proc.returncode}'}",
                required=False,
            )
        )

    def _check_speech(self, label: str, key_name: str, url_name: str, probe_path: str) -> None:
        key = self.env(key_name)
        base = self.env(url_name)
        component = label.lower()
        if not key and not base:
            self.add(
                CheckResult(
                    component,
                    SKIP,
                    f"{key_name} и {url_name} не заданы",
                    required=False,
                )
            )
            return
        if not key:
            self.add(
                CheckResult(
                    component,
                    SKIP,
                    f"{key_name} пуст, сервис выключен",
                    required=False,
                )
            )
            return
        if not base:
            self.add(
                CheckResult(
                    component,
                    WARN,
                    f"{key_name} задан, но {url_name} пуст",
                    required=False,
                )
            )
            return
        host_url = rewrite_url_for_host(base)
        parts = urlsplit(host_url)
        host = parts.hostname or "127.0.0.1"
        port = parts.port or (443 if parts.scheme == "https" else 80)
        error = tcp_open(host, port, self.timeout)
        if error is not None:
            self.add(
                CheckResult(
                    component,
                    WARN,
                    f"{host}:{port} недоступен с хоста ({error}); inference не вызывался",
                    required=False,
                )
            )
            return
        probe = http_get(host_url.rstrip("/") + "/", self.timeout)
        if probe.status is None:
            self.add(
                CheckResult(
                    component,
                    WARN,
                    f"{safe_url(host_url)} TCP есть, HTTP: {probe.error}; {probe_path} не вызывался",
                    required=False,
                )
            )
            return
        self.add(
            CheckResult(
                component,
                PASS,
                f"{safe_url(host_url)} отвечает HTTP {probe.status}; inference не вызывался",
                required=False,
            )
        )

    def run(self) -> list[CheckResult]:
        self.check_compose_config()
        self.check_containers()
        self.check_postgres()
        self.check_backend_http()
        self.check_frontend()
        self.check_inter_container()
        self.check_deep()
        return self.results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Проверка работоспособности уже запущенного InTime. Только чтение."
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="проверить настройку LLM/STT/TTS без платных inference-запросов",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="таймаут одной проверки в секундах (по умолчанию 5)",
    )
    parser.add_argument("--backend-url", help="например http://127.0.0.1:8010")
    parser.add_argument("--frontend-url", help="например http://127.0.0.1:3010")
    parser.add_argument("--compose-file", help="путь к docker-compose.yml")
    parser.add_argument("--project-dir", help="корень репозитория")
    parser.add_argument("--project-name", help="имя Compose-проекта, по умолчанию имя каталога")
    return parser


def resolve_urls(
    *,
    compose: list[str] | None,
    compose_file: Path,
    root: Path,
    timeout: float,
    backend_override: str | None,
    frontend_override: str | None,
) -> tuple[str, str]:
    backend = backend_override or os.environ.get("INTIME_BACKEND_URL", "").strip()
    frontend = frontend_override or os.environ.get("INTIME_FRONTEND_URL", "").strip()
    if not backend and compose is not None:
        published = compose_port(compose, compose_file, root, "backend", 8000, timeout)
        if published:
            backend = f"http://{published}"
    if not frontend and compose is not None:
        published = compose_port(compose, compose_file, root, "frontend", 80, timeout)
        if published:
            frontend = f"http://{published}"
    return backend or DEFAULT_BACKEND_URL, frontend or DEFAULT_FRONTEND_URL


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        print("timeout должен быть больше 0", file=sys.stderr)
        return 2
    root = Path(args.project_dir).resolve() if args.project_dir else Path(__file__).resolve().parent.parent
    compose_file = (
        Path(args.compose_file).resolve() if args.compose_file else root / "docker-compose.yml"
    )
    if not compose_file.is_file():
        print(f"нет файла Compose: {compose_file}", file=sys.stderr)
        return 2

    file_env = parse_env_file(root / ".env")
    secrets = secret_values({**file_env, **os.environ})
    project = (
        args.project_name
        or os.environ.get("COMPOSE_PROJECT_NAME", "").strip()
        or root.name.lower()
    )
    timeout = args.timeout
    compose = resolve_compose(timeout)
    docker_ok = docker_available(timeout)
    containers: dict[str, ContainerInfo] = {}
    if docker_ok:
        try:
            containers = list_project_containers(project, timeout)
        except subprocess.TimeoutExpired:
            containers = {}

    backend_url, frontend_url = resolve_urls(
        compose=compose,
        compose_file=compose_file,
        root=root,
        timeout=timeout,
        backend_override=args.backend_url,
        frontend_override=args.frontend_url,
    )
    checker = Checker(
        root=root,
        compose_file=compose_file,
        project=project,
        timeout=timeout,
        deep=args.deep,
        backend_url=backend_url,
        frontend_url=frontend_url,
        secrets=secrets,
        compose=compose,
        containers=containers,
        docker_ok=docker_ok,
        file_env=file_env,
    )
    results = checker.run()
    print(format_report(results))
    return exit_code(results)


if __name__ == "__main__":
    raise SystemExit(main())
