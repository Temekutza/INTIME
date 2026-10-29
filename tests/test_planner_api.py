import asyncio
import uuid

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.main import app


class Accounts:
    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.logins: list[str] = []

    def register(self, client: TestClient | None = None, **extra: object) -> dict:
        http = client or self.client
        login = f"u{uuid.uuid4().hex[:12]}"
        payload = {"login": login, "password": "password1", "timezone": "Europe/Moscow"}
        payload.update(extra)
        response = http.post("/api/v1/auth/register", json=payload)
        assert response.status_code == 201, response.text
        self.logins.append(login)
        return response.json()


@pytest.fixture
def accounts(client: TestClient) -> Accounts:
    created = Accounts(client)
    yield created
    if not created.logins:
        return

    async def wipe() -> None:
        conn = await asyncpg.connect(
            host="127.0.0.1",
            port=5435,
            user="aivritm",
            password="aivritm",
            database="aivritm",
        )
        await conn.execute("DELETE FROM users WHERE login = ANY($1::text[])", created.logins)
        await conn.close()

    asyncio.run(wipe())


def test_register_login_and_profile(client: TestClient, accounts: Accounts) -> None:
    created = accounts.register(email="Person@example.com")
    assert created["user"]["timezone"] == "Europe/Moscow"
    token = created["token"]

    me = client.get("/api/v1/users/me")
    assert me.status_code == 200
    assert me.json()["login"] == created["user"]["login"]

    with TestClient(app) as other:
        by_header = other.get("/api/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    assert by_header.status_code == 200

    renamed = client.patch("/api/v1/users/me", json={"timezone": "UTC", "email": None})
    assert renamed.status_code == 200
    assert renamed.json()["timezone"] == "UTC"
    assert renamed.json()["email"] is None

    client.cookies.clear()
    denied = client.get("/api/v1/users/me")
    assert denied.status_code == 401

    logged_in = client.post(
        "/api/v1/auth/login",
        json={"login": created["user"]["login"], "password": "password1"},
    )
    assert logged_in.status_code == 200
    assert client.get("/api/v1/users/me").status_code == 200

    wrong = client.post(
        "/api/v1/auth/login",
        json={"login": created["user"]["login"], "password": "wrong-password"},
    )
    assert wrong.status_code == 401

    duplicate = client.post(
        "/api/v1/auth/register",
        json={"login": created["user"]["login"], "password": "password1"},
    )
    assert duplicate.status_code == 409


def test_items_catalog_and_owner(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    types = client.get("/api/v1/item-types")
    assert types.status_code == 200
    assert {item["code"] for item in types.json()} == {"task", "meeting", "reminder"}

    statuses = client.get("/api/v1/item-types/task/statuses")
    assert statuses.status_code == 200
    assert "todo" in {item["code"] for item in statuses.json()}
    assert client.get("/api/v1/item-types/unknown/statuses").status_code == 404

    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Купить молоко"})
    assert created.status_code == 201, created.text
    item = created.json()
    assert item["status"] == "todo"
    item_id = item["id"]

    meeting = client.post(
        "/api/v1/items",
        json={
            "item_type": "meeting",
            "title": "Стендап",
            "start_at": "2026-10-30T10:00:00+03:00",
            "end_at": "2026-10-30T10:15:00+03:00",
        },
    )
    assert meeting.status_code == 201, meeting.text

    missing_start = client.post("/api/v1/items", json={"item_type": "meeting", "title": "Без начала"})
    assert missing_start.status_code == 422

    wrong_status = client.post(
        "/api/v1/items",
        json={"item_type": "task", "title": "Чужой статус", "status": "scheduled"},
    )
    assert wrong_status.status_code == 422

    fetched = client.get(f"/api/v1/items/{item_id}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Купить молоко"

    patched = client.patch(
        f"/api/v1/items/{item_id}",
        json={"due_at": "2026-10-30T18:00:00+03:00", "status": "in_progress"},
    )
    assert patched.status_code == 200
    assert patched.json()["status"] == "in_progress"
    assert patched.json()["due_on"] is None

    listed = client.get("/api/v1/items", params={"q": "молоко", "item_type": "task"})
    assert listed.status_code == 200
    assert listed.json()["total"] == 1

    window = client.get(
        "/api/v1/items",
        params={"from": "2026-10-30T09:00:00+03:00", "to": "2026-10-30T11:00:00+03:00"},
    )
    assert window.status_code == 200
    assert {row["title"] for row in window.json()["items"]} == {"Стендап"}

    type_change = client.patch(f"/api/v1/items/{item_id}", json={"item_type": "reminder"})
    assert type_change.status_code == 422

    with TestClient(app) as other:
        accounts.register(other)
        hidden = other.get(f"/api/v1/items/{item_id}")
        assert hidden.status_code == 404
        assert other.delete(f"/api/v1/items/{item_id}").status_code == 404

    assert client.delete(f"/api/v1/items/{item_id}").status_code == 204
    assert client.get(f"/api/v1/items/{item_id}").status_code == 404


def test_items_require_auth_and_schedule_rules(client: TestClient, accounts: Accounts) -> None:
    assert client.get("/api/v1/items").status_code == 401
    assert client.get("/api/v1/item-types").status_code == 401
    assert client.post("/api/v1/items", json={"item_type": "task", "title": "Без входа"}).status_code == 401

    short = client.post("/api/v1/auth/register", json={"login": "ab", "password": "short"})
    assert short.status_code == 422
    bad_zone = client.post(
        "/api/v1/auth/register",
        json={"login": "zoneuser", "password": "password1", "timezone": "Not/AZone"},
    )
    assert bad_zone.status_code == 422

    accounts.register()
    both_deadlines = client.post(
        "/api/v1/items",
        json={
            "item_type": "task",
            "title": "Два срока",
            "due_on": "2026-10-30",
            "due_at": "2026-10-30T12:00:00+03:00",
        },
    )
    assert both_deadlines.status_code == 422

    backwards = client.post(
        "/api/v1/items",
        json={
            "item_type": "meeting",
            "title": "Наоборот",
            "start_at": "2026-10-30T12:00:00+03:00",
            "end_at": "2026-10-30T11:00:00+03:00",
        },
    )
    assert backwards.status_code == 422

    reminder = client.post(
        "/api/v1/items",
        json={
            "item_type": "reminder",
            "title": "Позвонить",
            "remind_at": "2026-10-30T09:00:00+03:00",
        },
    )
    assert reminder.status_code == 201, reminder.text
    assert reminder.json()["status"] == "pending"
    reminder_id = reminder.json()["id"]

    missing_time = client.post("/api/v1/items", json={"item_type": "reminder", "title": "Без времени"})
    assert missing_time.status_code == 422

    renamed = client.patch(f"/api/v1/items/{reminder_id}", json={"title": "Позвонить маме"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Позвонить маме"

    by_status = client.get("/api/v1/items", params={"item_type": "reminder", "status": "pending"})
    assert by_status.status_code == 200
    assert by_status.json()["total"] == 1

    assert client.get("/api/v1/items/999999999").status_code == 404


def test_assistant_and_voice_need_configuration(client: TestClient, accounts: Accounts) -> None:
    assert client.post("/api/v1/assistant/messages", json={"text": "что у меня завтра"}).status_code == 401
    accounts.register()
    assistant = client.post("/api/v1/assistant/messages", json={"text": "что у меня завтра"})
    assert assistant.status_code == 503

    speech = client.post("/api/v1/voice/speech", json={"text": "доброе утро"})
    assert speech.status_code == 503

    transcription = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"RIFFxxxx", "audio/wav")},
    )
    assert transcription.status_code == 503

    empty = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert empty.status_code == 422
