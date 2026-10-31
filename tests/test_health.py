def test_health_reports_database(client) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_live_does_not_query_database(client) -> None:
    response = client.get("/api/v1/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_compat_health_matches_v1_readiness(client) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_health_returns_503_when_database_unavailable(client, monkeypatch) -> None:
    async def unavailable() -> bool:
        return False

    monkeypatch.setattr("app.api.v1.health.probe_database", unavailable)
    for path in ("/api/v1/health", "/api/health"):
        response = client.get(path)
        assert response.status_code == 503, path
        assert response.json() == {"status": "error", "database": "unavailable"}
        assert "password" not in response.text.lower()
        assert "traceback" not in response.text.lower()


def test_health_is_listed_in_openapi(client) -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/api/v1/health" in paths
    assert "/api/v1/live" in paths
    assert "get" in paths["/api/v1/health"]
    assert "get" in paths["/api/v1/live"]


def test_unknown_path_returns_404(client) -> None:
    response = client.get("/api/v1/missing")

    assert response.status_code == 404


def test_swagger_ui_is_served(client) -> None:
    response = client.get("/docs")

    assert response.status_code == 200
    assert "Swagger UI" in response.text
    assert "/openapi.json" in response.text


def test_openapi_lists_planner_routes(client) -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200
    paths = response.json()["paths"]
    expected = {
        "/api/v1/health",
        "/api/v1/live",
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/users/me",
        "/api/v1/items",
        "/api/v1/items/{item_id}",
        "/api/v1/item-types",
        "/api/v1/item-types/{type}/statuses",
        "/api/v1/assistant/messages",
        "/api/v1/voice/transcriptions",
        "/api/v1/voice/speech",
    }
    missing = expected - set(paths)
    assert not missing
    assert "get" in paths["/api/v1/users/me"]
    assert "patch" in paths["/api/v1/users/me"]
    assert "post" in paths["/api/v1/items"]
    assert "get" in paths["/api/v1/items"]
    assert "patch" in paths["/api/v1/items/{item_id}"]
    assert "delete" in paths["/api/v1/items/{item_id}"]
