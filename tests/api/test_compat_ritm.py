import pytest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.errors import BadGateway
from app.main import app
from tests.conftest import Accounts


def _stub_llm(monkeypatch: pytest.MonkeyPatch, payload: dict | BaseException) -> None:
    async def complete(_messages: list[dict[str, str]]) -> dict:
        if isinstance(payload, BaseException):
            raise payload
        return payload

    monkeypatch.setattr("app.services.assistant_service.llm.complete", complete)


def test_compat_health_does_not_need_login(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_compat_without_demo_user_is_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "compat_user_login", "missing-demo")
    response = client.get("/api/events")
    assert response.status_code == 503


def test_compat_falls_back_to_demo_user(client: TestClient, accounts: Accounts) -> None:
    accounts.register(login="anna")
    client.cookies.clear()
    response = client.get("/api/events")
    assert response.status_code == 200
    assert response.json()["events"] == []


def test_events_crud_search_and_colors(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Купить краску",
            "date": "2028-06-01",
            "time": "18:00",
            "color": "#2255aa",
            "session_id": "form-1",
            "request_id": "req-create-1",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["kind"] == "created"
    event = body["events"][0]
    assert event["title"] == "Купить краску"
    assert event["type"] == "task"
    assert event["status"] == "planned"
    assert event["date"] == "2028-06-01"
    assert event["time"] == "18:00"
    event_id = event["id"]

    listed = client.get("/api/events")
    assert listed.status_code == 200
    assert {row["id"] for row in listed.json()["events"]} == {event_id}

    fetched = client.get(f"/api/events/{event_id}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Купить краску"

    colors = client.get("/api/colors")
    assert colors.status_code == 200
    snapshot = colors.json()
    assert snapshot["defaults"] == {"task": None, "meeting": None, "reminder": None}
    assert snapshot["overrides"][str(event_id)] == "#2255aa"

    painted = client.patch(
        "/api/colors/defaults/task", json={"color": "#847cce"}
    )
    assert painted.status_code == 200
    assert painted.json() == {"type": "task", "color": "#847cce"}
    assert client.get("/api/colors").json()["defaults"]["task"] == "#847cce"

    reset = client.patch("/api/colors/defaults/task", json={"color": None})
    assert reset.json() == {"type": "task", "color": None}

    cleared = client.patch(f"/api/events/{event_id}/color", json={"color": None})
    assert cleared.json() == {"event_id": event_id, "color": None}
    assert str(event_id) not in client.get("/api/colors").json()["overrides"]

    patched = client.patch(
        f"/api/events/{event_id}",
        json={"title": "Купить синюю краску", "status": "done"},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "Купить синюю краску"
    assert patched.json()["status"] == "done"

    hits = client.get("/api/search", params={"q": "синюю", "limit": 20})
    assert hits.status_code == 200
    assert hits.json()["hits"][0]["event"]["id"] == event_id

    deleted = client.delete(f"/api/events/{event_id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/events/{event_id}").status_code == 404
    assert client.get("/api/events").json()["events"] == []


def test_form_create_is_idempotent_and_conflicts_on_different_payload(
    client: TestClient, accounts: Accounts
) -> None:
    accounts.register()
    payload = {
        "type": "task",
        "title": "Один раз",
        "session_id": "form-dup",
        "request_id": "same-id",
    }
    first = client.post("/api/events", json=payload)
    second = client.post("/api/events", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["kind"] == "duplicate"
    assert first.json()["events"][0]["id"] == second.json()["events"][0]["id"]
    assert len(client.get("/api/events").json()["events"]) == 1

    conflict = client.post(
        "/api/events",
        json={**payload, "title": "Другое название"},
    )
    assert conflict.status_code == 409
    assert len(client.get("/api/events").json()["events"]) == 1


def test_meeting_conflict_and_past_date_ask_before_write(
    client: TestClient, accounts: Accounts
) -> None:
    accounts.register()
    first = client.post(
        "/api/events",
        json={
            "type": "meeting",
            "title": "Уже стоит",
            "date": "2028-06-01",
            "time": "11:00",
            "duration_min": 60,
            "session_id": "form-meet",
            "request_id": "meet-1",
        },
    )
    assert first.json()["kind"] == "created"
    clash = client.post(
        "/api/events",
        json={
            "type": "meeting",
            "title": "Конфликт",
            "date": "2028-06-01",
            "time": "11:30",
            "duration_min": 60,
            "session_id": "form-meet",
            "request_id": "meet-2",
        },
    )
    assert clash.status_code == 200
    assert clash.json()["kind"] == "confirm"
    assert clash.json()["expecting"] == "confirmation"
    titles = {row["title"] for row in client.get("/api/events").json()["events"]}
    assert titles == {"Уже стоит"}

    confirmed = client.post(
        "/api/message",
        json={"session_id": "form-meet", "request_id": "meet-yes", "text": "Да"},
    )
    assert confirmed.json()["kind"] == "created"
    assert {row["title"] for row in client.get("/api/events").json()["events"]} == {
        "Уже стоит",
        "Конфликт",
    }

    past = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Просроченная",
            "date": "2020-01-01",
            "session_id": "form-past",
            "request_id": "past-1",
        },
    )
    assert past.json()["kind"] == "confirm"
    assert "Просроченная" not in {
        row["title"] for row in client.get("/api/events").json()["events"]
    }


def test_message_requires_confirmation_and_restores_history(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(
        monkeypatch,
        {
            "action": "create",
            "reply": "Запишу задачу",
            "item": {"item_type": "task", "title": "Проверить карточку"},
        },
    )
    asked = client.post(
        "/api/message",
        json={
            "session_id": "chat-1",
            "request_id": "msg-1",
            "text": "Поставь задачу проверить карточку",
            "require_confirmation": True,
            "new_event_color": "#2255aa",
        },
    )
    assert asked.status_code == 200, asked.text
    assert asked.json()["kind"] == "confirm"
    assert asked.json()["proposal"]["title"] == "Проверить карточку"
    assert asked.json()["proposal"]["color"] == "#2255aa"
    assert client.get("/api/events").json()["events"] == []

    history = client.get("/api/history", params={"session_id": "chat-1", "limit": 50})
    assert history.status_code == 200
    messages = history.json()["messages"]
    last = messages[-1]
    assert last["kind"] == "confirm"
    assert last["active_confirmation"] is True
    assert last["pending_color"] == "#2255aa"
    assert last["expecting"] == "confirmation"
    assert last["suggestions"] == ["Да", "Нет"]

    cancelled = client.post(
        "/api/message",
        json={"session_id": "chat-1", "request_id": "msg-no", "text": "Нет"},
    )
    assert cancelled.json()["kind"] == "cancelled"
    assert client.get("/api/events").json()["events"] == []

    asked_again = client.post(
        "/api/message",
        json={
            "session_id": "chat-1",
            "request_id": "msg-2",
            "text": "Поставь задачу проверить карточку",
            "require_confirmation": True,
            "new_event_color": "#2255aa",
        },
    )
    assert asked_again.json()["kind"] == "confirm"
    created = client.post(
        "/api/message",
        json={
            "session_id": "chat-1",
            "request_id": "msg-yes",
            "text": "Да",
            "new_event_color": "#2255aa",
        },
    )
    assert created.json()["kind"] == "created"
    events = client.get("/api/events").json()["events"]
    assert len(events) == 1
    assert events[0]["title"] == "Проверить карточку"
    assert client.get("/api/colors").json()["overrides"][str(events[0]["id"])] == "#2255aa"

    replay = client.post(
        "/api/message",
        json={
            "session_id": "chat-1",
            "request_id": "msg-yes",
            "text": "Да",
            "new_event_color": "#2255aa",
        },
    )
    assert replay.json()["kind"] == "created"
    assert len(client.get("/api/events").json()["events"]) == 1

    clash = client.post(
        "/api/message",
        json={"session_id": "chat-1", "request_id": "msg-yes", "text": "Нет"},
    )
    assert clash.status_code == 409


def test_message_update_waits_for_confirmation(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    created = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Документ task",
            "request_id": "rename-src",
        },
    )
    assert created.status_code == 200, created.text
    event_id = created.json()["events"][0]["id"]
    _stub_llm(
        monkeypatch,
        {
            "action": "update",
            "reply": "Переименую после подтверждения",
            "item_id": event_id,
            "item": {"title": "Новый документ task"},
        },
    )
    asked = client.post(
        "/api/message",
        json={
            "session_id": "rename-1",
            "request_id": "rename-ask",
            "text": "Переименуй задачу «Документ task» в «Новый документ task»",
            "require_confirmation": True,
        },
    )
    assert asked.status_code == 200, asked.text
    assert asked.json()["kind"] == "confirm"
    assert asked.json()["proposal"]["title"] == "Новый документ task"
    assert asked.json()["expecting"] == "confirmation"
    assert client.get("/api/events").json()["events"][0]["title"] == "Документ task"

    confirmed = client.post(
        "/api/message",
        json={"session_id": "rename-1", "request_id": "rename-yes", "text": "Да"},
    )
    assert confirmed.json()["kind"] == "updated"
    assert confirmed.json()["events"][0]["title"] == "Новый документ task"
    assert client.get("/api/events").json()["events"][0]["title"] == "Новый документ task"


def test_message_without_confirmation_writes_immediately(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(
        monkeypatch,
        {
            "action": "create",
            "reply": "Готово",
            "item": {"item_type": "task", "title": "Сразу"},
        },
    )
    response = client.post(
        "/api/message",
        json={"session_id": "chat-fast", "request_id": "fast-1", "text": "запиши сразу"},
    )
    assert response.json()["kind"] == "created"
    assert client.get("/api/events").json()["events"][0]["title"] == "Сразу"


def test_compat_does_not_show_foreign_events(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post("/api/events", json={"type": "task", "title": "Секрет", "request_id": "own"})
    item_id = created.json()["events"][0]["id"]

    with TestClient(app) as other:
        accounts.register(other)
        listed = other.get("/api/events")
        assert listed.json()["events"] == []
        assert other.patch(f"/api/events/{item_id}", json={"title": "Чужое"}).status_code == 404
        assert other.delete(f"/api/events/{item_id}").status_code == 404

    kept = client.get(f"/api/events/{item_id}")
    assert kept.status_code == 200
    assert kept.json()["title"] == "Секрет"


def test_speech_pcm_mocked(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()

    async def transcribe(name: str, content: bytes, content_type: str) -> str:
        assert name == "speech.wav"
        assert content_type == "audio/wav"
        assert content[:4] == b"RIFF"
        return "купить молоко"

    monkeypatch.setattr("app.services.compat_service.stt.transcribe", transcribe)
    response = client.post(
        "/api/speech",
        content=b"\x00\x01" * 400,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "купить молоко"}


def test_speech_unavailable_without_key(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post(
        "/api/speech",
        content=b"\x00\x01" * 400,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 503


def test_speech_empty_rejected(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post(
        "/api/speech",
        content=b"",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 422


def test_v1_items_still_work(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Старый контракт"})
    assert created.status_code == 201
    listed = client.get("/api/v1/items")
    assert listed.json()["total"] == 1
    compat = client.get("/api/events")
    assert compat.json()["events"][0]["title"] == "Старый контракт"
    assert compat.json()["events"][0]["status"] == "planned"


def test_tomorrow_question_reads_records_without_model(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()

    async def complete(_messages: list[dict[str, str]]) -> dict:
        raise AssertionError("для показа модель не вызывается")

    monkeypatch.setattr("app.services.assistant_service.llm.complete", complete)
    tomorrow = datetime.now(ZoneInfo("Europe/Moscow")).date() + timedelta(days=1)
    created = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Прием",
            "date": tomorrow.isoformat(),
            "time": "10:00",
            "request_id": "tomorrow-task",
        },
    )
    assert created.status_code == 200, created.text
    asked = client.post(
        "/api/message",
        json={"session_id": "days", "request_id": "ask-tomorrow", "text": "а что там на завтра"},
    )
    assert asked.status_code == 200, asked.text
    body = asked.json()
    assert body["kind"] == "info"
    assert "Прием" in body["text"]
    assert "10:00" in body["text"]
    assert body["events"][0]["date"] == tomorrow.isoformat()

    today = client.post(
        "/api/message",
        json={"session_id": "days", "request_id": "ask-today", "text": "какие задачи на сегодня"},
    )
    assert today.status_code == 200, today.text
    assert today.json()["events"] == []
    assert "нет" in today.json()["text"]


def test_profanity_inside_task_is_masked_and_task_is_created(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    seen: dict[str, str] = {}

    async def complete(messages: list[dict[str, str]]) -> dict:
        seen["user"] = messages[-1]["content"]
        return {
            "action": "create",
            "reply": "Запишу прием",
            "item": {"item_type": "task", "title": "прием блять", "due_on": "2026-11-02"},
        }

    monkeypatch.setattr("app.services.assistant_service.llm.complete", complete)
    response = client.post(
        "/api/message",
        json={
            "session_id": "swear",
            "request_id": "swear-1",
            "text": "запиши задачу в 10 утра на прием блять",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "created"
    assert response.json()["events"][0]["title"] == "прием"
    assert "блять" not in seen["user"]
    assert "запиши задачу в 10 утра на прием" in seen["user"]
    history = client.get("/api/history", params={"session_id": "swear", "limit": 20})
    user_lines = [row["text"] for row in history.json()["messages"] if row["role"] == "user"]
    assert user_lines[0] == "запиши задачу в 10 утра на прием *****"
    assert "блять" not in user_lines[0]


def test_message_llm_failure_does_not_write(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(monkeypatch, BadGateway("LLM не ответил"))
    response = client.post(
        "/api/message",
        json={"session_id": "chat-fail", "request_id": "fail-1", "text": "запиши встречу с Петром"},
    )
    assert response.status_code == 502
    assert client.get("/api/events").json()["events"] == []


def test_message_creates_up_to_three_and_confirms_each(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    _stub_llm(
        monkeypatch,
        {
            "action": "create",
            "reply": "Три задачи",
            "items": [
                {"item_type": "task", "title": "Молоко"},
                {"item_type": "task", "title": "Хлеб"},
                {"item_type": "task", "title": "Сыр"},
                {"item_type": "task", "title": "Лишняя"},
            ],
        },
    )
    asked = client.post(
        "/api/message",
        json={
            "session_id": "batch",
            "request_id": "batch-1",
            "text": "запиши молоко, хлеб, сыр и ещё одну",
            "require_confirmation": True,
        },
    )
    body = asked.json()
    assert asked.status_code == 200, asked.text
    assert body["kind"] == "confirm"
    assert body["proposal"]["title"] == "Молоко"
    assert "Хлеб" in body["text"]
    assert "Сыр" in body["text"]
    assert "Лишняя" not in body["text"]
    assert "первые три" in body["text"]
    assert client.get("/api/events").json()["events"] == []

    first = client.post(
        "/api/message",
        json={"session_id": "batch", "request_id": "batch-yes-1", "text": "Да"},
    )
    assert first.json()["kind"] == "created"
    assert first.json()["expecting"] == "confirmation"
    assert first.json()["proposal"]["title"] == "Хлеб"
    assert [row["title"] for row in client.get("/api/events").json()["events"]] == ["Молоко"]

    second = client.post(
        "/api/message",
        json={"session_id": "batch", "request_id": "batch-yes-2", "text": "Да"},
    )
    assert second.json()["proposal"]["title"] == "Сыр"
    third = client.post(
        "/api/message",
        json={"session_id": "batch", "request_id": "batch-yes-3", "text": "Да"},
    )
    assert third.json()["kind"] == "created"
    assert third.json()["expecting"] is None
    assert {row["title"] for row in client.get("/api/events").json()["events"]} == {
        "Молоко",
        "Хлеб",
        "Сыр",
    }


def test_message_delete_uses_title_and_time(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    tomorrow = (datetime.now(ZoneInfo("Europe/Moscow")) + timedelta(days=1)).date().isoformat()
    kept = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Отчёт",
            "date": tomorrow,
            "time": "10:00",
            "is_deadline": True,
            "request_id": "keep-task",
        },
    )
    target = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Прием",
            "date": tomorrow,
            "time": "10:00",
            "is_deadline": True,
            "request_id": "drop-task",
        },
    )
    assert kept.status_code == 200 and target.status_code == 200
    wrong_id = kept.json()["events"][0]["id"]
    right_id = target.json()["events"][0]["id"]
    _stub_llm(
        monkeypatch,
        {"action": "delete", "reply": "Удаляю", "item_id": wrong_id},
    )
    response = client.post(
        "/api/message",
        json={
            "session_id": "drop",
            "request_id": "drop-1",
            "text": "удали задачу прием завтра в 10:00",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "deleted"
    titles = {row["title"] for row in client.get("/api/events").json()["events"]}
    assert titles == {"Отчёт"}
    assert client.get(f"/api/events/{right_id}").status_code == 404


def test_message_delete_asks_when_several_match(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()
    tomorrow = (datetime.now(ZoneInfo("Europe/Moscow")) + timedelta(days=1)).date().isoformat()
    for title, request_id in (("Прием", "a"), ("Отчёт", "b")):
        created = client.post(
            "/api/events",
            json={
                "type": "task",
                "title": title,
                "date": tomorrow,
                "time": "10:00",
                "is_deadline": True,
                "request_id": request_id,
            },
        )
        assert created.status_code == 200, created.text
    _stub_llm(monkeypatch, {"action": "delete", "reply": "Удаляю первую", "item_id": 1})
    response = client.post(
        "/api/message",
        json={
            "session_id": "ask",
            "request_id": "ask-1",
            "text": "удали задачу завтра в 10:00",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kind"] == "choice"
    assert {row["title"] for row in body["events"]} == {"Прием", "Отчёт"}
    assert {row["title"] for row in client.get("/api/events").json()["events"]} == {"Прием", "Отчёт"}

    chosen = client.post(
        "/api/message",
        json={"session_id": "ask", "request_id": "ask-2", "text": "первую"},
    )
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["kind"] == "deleted"
    assert len(client.get("/api/events").json()["events"]) == 1
