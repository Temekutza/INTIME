"""Изолированная Postgres для тестов.

Рабочая база `intime` запрещена. Схема каждый прогон берётся из backend/sql/*.sql,
чтобы тестовая БД оставалась согласованной с файлами схемы.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.pq import ExecStatus

ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "backend" / "sql"

FORBIDDEN_DATABASES = frozenset({"intime", "postgres", "template0", "template1"})
DEFAULT_TEST_DATABASE = "intime_test"
_DOTENV_KEYS = frozenset({"POSTGRES_USER", "POSTGRES_PASSWORD"})
_DB_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass(frozen=True)
class PostgresTarget:
    host: str
    port: int
    user: str
    password: str
    database: str
    sql_files: tuple[Path, ...]

    @property
    def dsn_kwargs(self) -> dict[str, str | int]:
        return {
            "host": self.host,
            "port": self.port,
            "user": self.user,
            "password": self.password,
            "dbname": self.database,
        }


def load_dotenv_credentials() -> None:
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


def configure_test_environment() -> PostgresTarget:
    """Выставляет окружение до импорта приложения. POSTGRES_DB из .env игнорируется."""
    load_dotenv_credentials()
    database = os.environ.get("TEST_POSTGRES_DB", DEFAULT_TEST_DATABASE).strip()
    _reject_application_database(database)

    os.environ["POSTGRES_HOST"] = os.environ.get("TEST_POSTGRES_HOST", "127.0.0.1")
    os.environ["POSTGRES_PORT"] = os.environ.get("TEST_POSTGRES_PORT", "5435")
    os.environ["POSTGRES_DB"] = database
    os.environ["POSTGRES_USER"] = os.environ.get("POSTGRES_USER", "intime")
    os.environ["POSTGRES_PASSWORD"] = os.environ.get("POSTGRES_PASSWORD", "intime")
    os.environ["LLM_API_KEY"] = ""
    os.environ["STT_API_KEY"] = ""
    os.environ["TTS_API_KEY"] = ""

    if os.environ["POSTGRES_DB"] in FORBIDDEN_DATABASES:
        raise RuntimeError(
            f"Отказ: тесты нельзя запускать против базы {os.environ['POSTGRES_DB']!r}."
        )

    return PostgresTarget(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ["POSTGRES_PORT"]),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        database=database,
        sql_files=schema_sql_files(),
    )


def schema_sql_files() -> tuple[Path, ...]:
    files = tuple(sorted(path for path in SQL_DIR.glob("*.sql") if path.is_file()))
    if not files:
        raise RuntimeError(f"В {SQL_DIR} нет .sql файлов схемы")
    for path in files:
        if not re.match(r"^\d{3}_.+\.sql$", path.name):
            raise RuntimeError(
                f"Файл схемы {path.name} должен называться NNN_описание.sql, "
                "чтобы тестовая БД накатывала их в том же порядке, что и основная"
            )
    return files


def _reject_application_database(name: str) -> None:
    if name in FORBIDDEN_DATABASES or name == "intime":
        raise RuntimeError(
            f"Отказ: тесты нельзя запускать против базы {name!r}. "
            f"Нужна изолированная база (по умолчанию {DEFAULT_TEST_DATABASE})."
        )
    if not name.endswith("_test"):
        raise RuntimeError(
            f"Отказ: имя тестовой базы {name!r} должно оканчиваться на '_test'."
        )
    if not _DB_NAME.fullmatch(name):
        raise RuntimeError(f"Отказ: недопустимое имя базы {name!r}.")


def _assert_safe_database(name: str) -> None:
    _reject_application_database(name)


def execute_script(conn: psycopg.Connection, script: str) -> None:
    result = conn.pgconn.exec_(script.encode("utf-8"))
    status = result.status
    if status not in (ExecStatus.COMMAND_OK, ExecStatus.TUPLES_OK, ExecStatus.EMPTY_QUERY):
        raw = conn.pgconn.error_message or result.error_message or ""
        message = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        raise RuntimeError(message or f"SQL-скрипт завершился со статусом {status}")


def connect_admin(target: PostgresTarget) -> psycopg.Connection:
    return psycopg.connect(
        host=target.host,
        port=target.port,
        user=target.user,
        password=target.password,
        dbname="postgres",
        autocommit=True,
    )


def connect_test(target: PostgresTarget) -> psycopg.Connection:
    _assert_safe_database(target.database)
    conn = psycopg.connect(autocommit=True, **target.dsn_kwargs)
    if conn.info.dbname != target.database:
        conn.close()
        raise RuntimeError("Подключение открылось не к тестовой базе")
    _assert_safe_database(conn.info.dbname)
    return conn


def ensure_database(target: PostgresTarget) -> None:
    _assert_safe_database(target.database)
    with connect_admin(target) as conn:
        found = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s",
            (target.database,),
        ).fetchone()
        if found is None:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target.database)))


def reset_schema(target: PostgresTarget) -> tuple[Path, ...]:
    """Пересоздаёт public в тестовой БД и накатывает все backend/sql/*.sql."""
    _assert_safe_database(target.database)
    with connect_test(target) as conn:
        if conn.info.dbname in FORBIDDEN_DATABASES:
            raise RuntimeError("Отказ: DROP SCHEMA на запрещённой базе")
        execute_script(
            conn,
            "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;",
        )
        for path in target.sql_files:
            execute_script(conn, path.read_text(encoding="utf-8"))
    return target.sql_files


def delete_all_users(target: PostgresTarget) -> None:
    _assert_safe_database(target.database)
    with connect_test(target) as conn:
        conn.execute("DELETE FROM users")
