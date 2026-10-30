from fastapi.testclient import TestClient

from tests.conftest import Accounts


def test_register_duplicate_email(client: TestClient, accounts: Accounts) -> None:
    accounts.register(email="same@example.com")
    taken = client.post(
        "/api/v1/auth/register",
        json={"login": "otheruser", "password": "password1", "email": "same@example.com"},
    )
    assert taken.status_code == 409


def test_register_login_case_insensitive_unique(client: TestClient, accounts: Accounts) -> None:
    accounts.register(login="CaseUser")
    taken = client.post(
        "/api/v1/auth/register",
        json={"login": "caseuser", "password": "password1"},
    )
    assert taken.status_code == 409


def test_login_unknown_user(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={"login": "missing-user", "password": "password1"},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Неверный логин или пароль"}


def test_login_is_case_insensitive(client: TestClient, accounts: Accounts) -> None:
    accounts.register(login="AnnaLogin")
    client.cookies.clear()
    response = client.post(
        "/api/v1/auth/login",
        json={"login": "annalogin", "password": "password1"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["login"] == "AnnaLogin"


def test_patch_me_conflict_on_taken_login(client: TestClient, accounts: Accounts) -> None:
    accounts.register(login="firstuser")
    second = accounts.register(login="seconduser")
    assert second["user"]["login"] == "seconduser"
    conflict = client.patch("/api/v1/users/me", json={"login": "firstuser"})
    assert conflict.status_code == 409
