from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import Accounts
from tests.postgres_harness import PostgresTarget, connect_test


def test_cannot_patch_someone_elses_item(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Секрет"})
    assert created.status_code == 201
    item_id = created.json()["id"]

    with TestClient(app) as other:
        accounts.register(other)
        patched = other.patch(f"/api/v1/items/{item_id}", json={"title": "Чужое"})
        assert patched.status_code == 404

    kept = client.get(f"/api/v1/items/{item_id}")
    assert kept.status_code == 200
    assert kept.json()["title"] == "Секрет"


def test_list_does_not_mix_users(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    mine = client.post("/api/v1/items", json={"item_type": "task", "title": "Моя задача"})
    assert mine.status_code == 201

    with TestClient(app) as other:
        accounts.register(other)
        other.post("/api/v1/items", json={"item_type": "task", "title": "Чужая задача"})
        listed = other.get("/api/v1/items")
        assert listed.status_code == 200
        titles = {row["title"] for row in listed.json()["items"]}
        assert titles == {"Чужая задача"}
        assert listed.json()["total"] == 1


def test_search_escapes_like_wildcards(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    client.post("/api/v1/items", json={"item_type": "task", "title": "молоко"})
    client.post("/api/v1/items", json={"item_type": "task", "title": "100% скидка"})

    percent = client.get("/api/v1/items", params={"q": "%"})
    assert percent.status_code == 200
    titles = {row["title"] for row in percent.json()["items"]}
    assert titles == {"100% скидка"}

    underscore = client.get("/api/v1/items", params={"q": "_"})
    assert underscore.json()["total"] == 0


def test_naive_from_to_rejected(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.get("/api/v1/items", params={"from": "2026-10-30T09:00:00"})
    assert response.status_code == 422


def test_from_later_than_to_rejected(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.get(
        "/api/v1/items",
        params={"from": "2026-10-30T12:00:00+03:00", "to": "2026-10-30T09:00:00+03:00"},
    )
    assert response.status_code == 422


def test_blank_title_rejected(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post("/api/v1/items", json={"item_type": "task", "title": "   "})
    assert response.status_code == 422


def test_change_type_with_status(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Созвон"})
    item_id = created.json()["id"]
    patched = client.patch(
        f"/api/v1/items/{item_id}",
        json={
            "item_type": "reminder",
            "status": "pending",
            "remind_at": "2026-10-30T09:00:00+03:00",
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["item_type"] == "reminder"
    assert patched.json()["status"] == "pending"


def test_due_on_clears_due_at(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    created = client.post(
        "/api/v1/items",
        json={
            "item_type": "task",
            "title": "Срок",
            "due_at": "2026-10-30T18:00:00+03:00",
        },
    )
    item_id = created.json()["id"]
    patched = client.patch(f"/api/v1/items/{item_id}", json={"due_on": "2026-10-31"})
    assert patched.status_code == 200
    assert patched.json()["due_on"] == "2026-10-31"
    assert patched.json()["due_at"] is None


def test_delete_hides_item_but_keeps_row(
    client: TestClient, accounts: Accounts, test_database: PostgresTarget
) -> None:
    accounts.register()
    created = client.post("/api/v1/items", json={"item_type": "task", "title": "Удалить"})
    item_id = created.json()["id"]
    assert client.delete(f"/api/v1/items/{item_id}").status_code == 204
    assert client.get(f"/api/v1/items/{item_id}").status_code == 404
    with connect_test(test_database) as conn:
        row = conn.execute(
            "SELECT deleted_at FROM planner_items WHERE id = %s",
            (item_id,),
        ).fetchone()
    assert row is not None and row[0] is not None
