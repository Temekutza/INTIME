"""Пересоздаёт схему изолированной тестовой БД из backend/sql/*.sql.

Рабочие базы intime и aivritm запрещены. По умолчанию — intime_test.

    python scripts/testdatagen/apply_schema.py

Адрес: DATABASE_URL или POSTGRES_*. Имя базы: TEST_POSTGRES_DB.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg import sql

from db import (
    admin_url,
    database_name,
    database_url,
    describe_url,
    execute_script,
    reject_application_database,
    schema_sql_files,
)


def test_url() -> str:
    url = database_url()
    name = os.environ.get("TEST_POSTGRES_DB", "intime_test").strip()
    reject_application_database(name)
    parsed = urlparse(url)
    return urlunparse(parsed._replace(path=f"/{name}"))


def ensure_database(url: str) -> None:
    name = database_name(url)
    reject_application_database(name)
    with psycopg.connect(admin_url(url), autocommit=True) as conn:
        found = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        if found is None:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))


def reset_schema(url: str) -> tuple[str, ...]:
    name = database_name(url)
    reject_application_database(name)
    files = schema_sql_files()
    with psycopg.connect(url, autocommit=True) as conn:
        if conn.info.dbname != name:
            raise RuntimeError("Подключение открылось не к тестовой базе")
        execute_script(
            conn,
            "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;",
        )
        for path in files:
            execute_script(conn, path.read_text(encoding="utf-8"))
    return tuple(path.name for path in files)


def main() -> None:
    url = test_url()
    print(f"Схема: {describe_url(url)}")
    ensure_database(url)
    names = reset_schema(url)
    print("Накатываю: " + ", ".join(names))
    print("Готово.")


if __name__ == "__main__":
    try:
        main()
    except (psycopg.Error, RuntimeError) as exc:
        print(f"Ошибка базы: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
