"""Общие fixtures. Импорт приложения — только после настройки окружения."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.postgres_harness import (
    PostgresTarget,
    configure_test_environment,
    delete_all_users,
    ensure_database,
    reset_schema,
)

TARGET = configure_test_environment()


@pytest.fixture(scope="session")
def test_database() -> Iterator[PostgresTarget]:
    try:
        ensure_database(TARGET)
        reset_schema(TARGET)
    except Exception as exc:
        pytest.fail(
            f"Нет изолированной тестовой БД {TARGET.database!r} на "
            f"{TARGET.host}:{TARGET.port}: {exc}"
        )
    yield TARGET


@pytest.fixture
def client(test_database: PostgresTarget) -> Iterator[TestClient]:
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    delete_all_users(test_database)


class Accounts:
    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.logins: list[str] = []

    def register(self, client: TestClient | None = None, **extra: object) -> dict:
        http = client or self.client
        login = extra.pop("login", f"u{uuid.uuid4().hex[:12]}")
        payload = {"login": login, "password": "password1", "timezone": "Europe/Moscow"}
        payload.update(extra)
        response = http.post("/api/v1/auth/register", json=payload)
        assert response.status_code == 201, response.text
        self.logins.append(str(payload["login"]))
        return response.json()


@pytest.fixture
def accounts(client: TestClient) -> Iterator[Accounts]:
    yield Accounts(client)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        path = str(item.fspath)
        if "/tests/unit/" in path or path.endswith("/tests/unit"):
            item.add_marker(pytest.mark.unit)
        elif "/tests/integration/" in path:
            item.add_marker(pytest.mark.integration)
        elif "/tests/api/" in path or path.endswith("test_health.py") or path.endswith(
            "test_planner_api.py"
        ):
            item.add_marker(pytest.mark.api)
