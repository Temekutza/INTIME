import pytest
from fastapi.testclient import TestClient

from app.core.errors import BadGateway
from app.main import app
from tests.conftest import Accounts


def _stub_llm(monkeypatch: pytest.MonkeyPatch, payload: dict | BaseException) -> None:
    async def complete(_messages: list[dict[str, str]]) -> dict:
        if isinstance(payload, BaseException):
            raise payload
        return payload

    monkeypatch.setattr("app.services.assistant_service.llm.complete", complete)


def test_assistant_none_does_not_write(client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch) -> None:
    accounts.register()
    _stub_llm(monkeypatch, {"action": "none", "reply": "Уточните дату"})
    response = client.post("/api/v1/assistant/messages", json={"text": "запиши что-нибудь"})
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "none"
    assert body["items"] == []
    listed = client.get("/api/v1/items")
    assert listed.json()["total"] == 0


def test_assistant_create_task(client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch) -> None:
    accounts.register()
    _stub_llm(
        monkeypatch,
        {
            "action": "create",
            "reply": "Записала",
            "item": {"item_type": "task", "title": "Купить молоко"},
        },
    )
    response = client.post("/api/v1/assistant/messages", json={"text": "купи молоко"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["action"] == "create"
    assert body["items"][0]["title"] == "Купить молоко"
    listed = client.get("/api/v1/items")
    assert listed.json()["total"] == 1


def test_assistant_create_without_item_does_not_write(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(monkeypatch, {"action": "create", "reply": "ок", "item": None})
    response = client.post("/api/v1/assistant/messages", json={"text": "создай задачу"})
    assert response.status_code == 422
    assert client.get("/api/v1/items").json()["total"] == 0


def test_assistant_garbage_json_does_not_write(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(monkeypatch, {"hello": "world"})
    response = client.post("/api/v1/assistant/messages", json={"text": "что дальше"})
    assert response.status_code == 422
    assert client.get("/api/v1/items").json()["total"] == 0


def test_assistant_timeout_does_not_write(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(monkeypatch, BadGateway("LLM не ответил"))
    response = client.post("/api/v1/assistant/messages", json={"text": "переименуй черновик"})
    assert response.status_code == 502
    assert client.get("/api/v1/items").json()["total"] == 0


def test_assistant_update_and_delete_own_item(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Черновик"})
    item_id = created.json()["id"]

    _stub_llm(
        monkeypatch,
        {"action": "update", "reply": "обновила", "item_id": item_id, "item": {"title": "Готово"}},
    )
    updated = client.post("/api/v1/assistant/messages", json={"text": "переименуй в готово"})
    assert updated.status_code == 200
    assert updated.json()["items"][0]["title"] == "Готово"

    _stub_llm(monkeypatch, {"action": "delete", "reply": "удалила", "item_id": item_id})
    deleted = client.post("/api/v1/assistant/messages", json={"text": "удали задачу готово"})
    assert deleted.status_code == 200
    assert client.get(f"/api/v1/items/{item_id}").status_code == 404


def test_assistant_cannot_delete_foreign_item(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Чужое"})
    item_id = created.json()["id"]

    with TestClient(app) as other:
        accounts.register(other)
        _stub_llm(monkeypatch, {"action": "delete", "reply": "удаляю", "item_id": item_id})
        response = other.post("/api/v1/assistant/messages", json={"text": "удали задачу чужое"})
        assert response.status_code == 200
        assert response.json()["action"] == "none"

    kept = client.get(f"/api/v1/items/{item_id}")
    assert kept.status_code == 200
    assert kept.json()["title"] == "Чужое"


def test_assistant_delete_without_id_does_not_write(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Живая"})
    _stub_llm(monkeypatch, {"action": "delete", "reply": "какую?"})
    response = client.post("/api/v1/assistant/messages", json={"text": "удали задачу"})
    assert response.status_code == 200
    assert response.json()["action"] == "none"
    assert client.get(f"/api/v1/items/{created.json()['id']}").status_code == 200


def test_assistant_list_returns_own_items(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    client.post("/api/v1/items", json={"item_type": "task", "title": "Найди меня"})
    _stub_llm(
        monkeypatch,
        {"action": "list", "reply": "нашла", "filters": {"item_type": "task", "q": "Найди"}},
    )
    response = client.post("/api/v1/assistant/messages", json={"text": "какие задачи"})
    assert response.status_code == 200
    titles = {row["title"] for row in response.json()["items"]}
    assert titles == {"Найди меня"}
