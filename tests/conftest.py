import os
from collections.abc import Iterator

# .env указывает хост docker-сети. Тесты запускаются с хоста, через опубликованный порт.
os.environ["POSTGRES_HOST"] = os.environ.get("TEST_POSTGRES_HOST", "127.0.0.1")
os.environ["POSTGRES_PORT"] = os.environ.get("TEST_POSTGRES_PORT", "5435")

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
