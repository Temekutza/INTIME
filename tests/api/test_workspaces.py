from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import Accounts


def _space(client: TestClient, name: str) -> dict:
    created = client.post("/api/v1/workspaces", json={"name": name})
    assert created.status_code == 201, created.text
    return created.json()


def test_register_gets_default_workspace(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    listed = client.get("/api/v1/workspaces")
    assert listed.status_code == 200
    rows = listed.json()["workspaces"]
    assert len(rows) == 1
    assert rows[0]["name"] == "Общее пространство"
    assert rows[0]["is_default"] is True
    assert rows[0]["id"] >= 1


def test_create_rename_and_duplicate_workspace(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    work = _space(client, "  Работа  ")
    assert work["name"] == "Работа"
    assert work["is_default"] is False

    listed = client.get("/api/v1/workspaces")
    names = [row["name"] for row in listed.json()["workspaces"]]
    assert names == ["Общее пространство", "Работа"]

    renamed = client.patch(f"/api/v1/workspaces/{work['id']}", json={"name": "Офис"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Офис"

    duplicate = client.post("/api/v1/workspaces", json={"name": "офис"})
    assert duplicate.status_code == 409

    blank = client.post("/api/v1/workspaces", json={"name": "   "})
    assert blank.status_code == 422

    missing = client.patch("/api/v1/workspaces/999999", json={"name": "Нет"})
    assert missing.status_code == 404


def test_workspace_is_owned_and_filters_items(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    work = _space(client, "Работа")
    personal = _space(client, "Личное")

    report = client.post(
        "/api/v1/items",
        json={"item_type": "task", "title": "Отчёт", "workspace_id": work["id"]},
    )
    milk = client.post(
        "/api/v1/items",
        json={"item_type": "task", "title": "Молоко", "workspace_id": personal["id"]},
    )
    assert report.status_code == 201, report.text
    assert milk.status_code == 201, milk.text
    assert report.json()["workspace_id"] == work["id"]
    assert milk.json()["workspace_id"] == personal["id"]

    default_item = client.post("/api/v1/items", json={"item_type": "task", "title": "Общая"})
    assert default_item.status_code == 201
    default_id = client.get("/api/v1/workspaces").json()["workspaces"][0]["id"]
    assert default_item.json()["workspace_id"] == default_id

    filtered = client.get("/api/v1/items", params={"workspace_id": work["id"]})
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1
    assert filtered.json()["items"][0]["title"] == "Отчёт"

    all_items = client.get("/api/v1/items")
    assert all_items.json()["total"] == 3

    unknown = client.get("/api/v1/items", params={"workspace_id": 999999})
    assert unknown.status_code == 404

    with TestClient(app) as other:
        accounts.register(other)
        stolen = other.post(
            "/api/v1/items",
            json={"item_type": "task", "title": "Чужое", "workspace_id": work["id"]},
        )
        assert stolen.status_code == 404
        listed = other.get("/api/v1/items", params={"workspace_id": work["id"]})
        assert listed.status_code == 404
        patched = other.patch(f"/api/v1/workspaces/{work['id']}", json={"name": "Взлом"})
        assert patched.status_code == 404


def test_compat_workspaces_and_event_filter(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    listed = client.get("/api/workspaces")
    assert listed.status_code == 200
    default = listed.json()["workspaces"][0]
    assert default["name"] == "Общее пространство"

    work = client.post("/api/workspaces", json={"name": "Работа"})
    personal = client.post("/api/workspaces", json={"name": "Личное"})
    assert work.status_code == 201, work.text
    work_id = work.json()["id"]
    personal_id = personal.json()["id"]

    created = client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Стендап",
            "workspace_id": work_id,
            "request_id": "ws-create-1",
        },
    )
    assert created.status_code == 200, created.text
    event = created.json()["events"][0]
    assert event["workspace_id"] == work_id

    client.post(
        "/api/events",
        json={
            "type": "task",
            "title": "Купить хлеб",
            "workspace_id": personal_id,
            "request_id": "ws-create-2",
        },
    )

    in_work = client.get("/api/events", params={"workspace_id": work_id})
    assert {row["title"] for row in in_work.json()["events"]} == {"Стендап"}

    hits = client.get("/api/search", params={"q": "хлеб", "workspace_id": work_id})
    assert hits.status_code == 200
    assert hits.json()["hits"] == []

    personal_hits = client.get("/api/search", params={"q": "хлеб", "workspace_id": personal_id})
    assert personal_hits.json()["hits"][0]["event"]["title"] == "Купить хлеб"

    foreign = client.get("/api/events", params={"workspace_id": 999999})
    assert foreign.status_code == 404

    renamed = client.patch(f"/api/workspaces/{work_id}", json={"name": "Офис"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Офис"
