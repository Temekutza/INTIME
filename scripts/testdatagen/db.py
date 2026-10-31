"""Подключение и накат схемы для testdatagen. Пароль в лог не пишет."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse

from psycopg.pq import ExecStatus

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "backend" / "sql"
FORBIDDEN_DATABASES = frozenset({"intime", "aivritm", "postgres", "template0", "template1"})
_DOTENV_KEYS = frozenset(
    {"DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB"}
)
_DB_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


def load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in _DOTENV_KEYS and key not in os.environ:
            os.environ[key] = value


_DOCKER_DB_HOSTS = frozenset({"db", "intime-db-1"})


def _from_host(host: str, port: str) -> tuple[str, str]:
    # В контейнере Postgres слушает 5432 на хосте `db`; с хоста это 127.0.0.1:5435.
    if host in _DOCKER_DB_HOSTS:
        return "127.0.0.1", "5435"
    return host, port


def database_url() -> str:
    load_dotenv()
    if os.environ.get("DATABASE_URL"):
        parsed = urlparse(os.environ["DATABASE_URL"])
        host, port = _from_host(parsed.hostname or "127.0.0.1", str(parsed.port or 5432))
        user = quote(parsed.username or "", safe="")
        password = quote(parsed.password or "", safe="")
        db = (parsed.path or "/intime").lstrip("/")
        return f"postgresql://{user}:{password}@{host}:{port}/{db}"
    user = os.environ.get("POSTGRES_USER", "intime")
    password = os.environ.get("POSTGRES_PASSWORD", "intime")
    host, port = _from_host(
        os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        os.environ.get("POSTGRES_PORT", "5435"),
    )
    name = os.environ.get("POSTGRES_DB", "intime")
    return f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}/{name}"


def describe_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 5432
    db = (parsed.path or "/").lstrip("/") or "?"
    user = parsed.username or "?"
    return f"{user}@{host}:{port}/{db}"


def admin_url(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse(parsed._replace(path="/postgres"))


def database_name(url: str) -> str:
    return (urlparse(url).path or "/").lstrip("/")


def schema_sql_files() -> tuple[Path, ...]:
    files = tuple(sorted(path for path in SQL_DIR.glob("*.sql") if path.is_file()))
    if not files:
        raise RuntimeError(f"В {SQL_DIR} нет .sql файлов схемы")
    for path in files:
        if not re.match(r"^\d{3}_.+\.sql$", path.name):
            raise RuntimeError(f"Файл схемы {path.name} должен называться NNN_описание.sql")
    return files


def execute_script(conn, script: str) -> None:
    result = conn.pgconn.exec_(script.encode("utf-8"))
    status = result.status
    if status not in (ExecStatus.COMMAND_OK, ExecStatus.TUPLES_OK, ExecStatus.EMPTY_QUERY):
        raw = conn.pgconn.error_message or result.error_message or ""
        message = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        raise RuntimeError(message or f"SQL-скрипт завершился со статусом {status}")


def reject_application_database(name: str) -> None:
    if name in FORBIDDEN_DATABASES:
        raise RuntimeError(f"Отказ: нельзя накатывать тестовую схему на базу {name!r}.")
    if not name.endswith("_test"):
        raise RuntimeError(f"Отказ: имя тестовой базы {name!r} должно оканчиваться на '_test'.")
    if not _DB_NAME.fullmatch(name):
        raise RuntimeError(f"Отказ: недопустимое имя базы {name!r}.")
