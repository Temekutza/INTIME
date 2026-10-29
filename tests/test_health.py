def test_health_reports_database(client) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_health_is_listed_in_openapi(client) -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/api/v1/health" in paths
    assert "get" in paths["/api/v1/health"]


def test_unknown_path_returns_404(client) -> None:
    response = client.get("/api/v1/missing")

    assert response.status_code == 404
