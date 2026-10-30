import pytest
from pydantic import ValidationError

from app.schemas.auth import LoginRequest, RegisterRequest, UserUpdate


def test_register_accepts_minimal_payload() -> None:
    data = RegisterRequest(login="anna", password="password1")
    assert data.timezone == "UTC"
    assert data.email is None


@pytest.mark.parametrize(
    "payload",
    [
        {"login": " anna", "password": "password1"},
        {"login": "an na", "password": "password1"},
        {"login": "", "password": "password1"},
        {"login": "ok", "password": "short"},
        {"login": "ok", "password": "password1", "timezone": "Not/AZone"},
        {"login": "ok", "password": "password1", "email": "not-an-email"},
        {"login": "ok", "password": "password1", "email": "@x.com"},
        {"login": "a" * 65, "password": "password1"},
    ],
)
def test_register_rejects_invalid_payload(payload: dict) -> None:
    with pytest.raises(ValidationError):
        RegisterRequest.model_validate(payload)


def test_register_blank_email_becomes_none() -> None:
    data = RegisterRequest(login="anna", password="password1", email="  ")
    assert data.email is None


def test_login_rejects_empty_password() -> None:
    with pytest.raises(ValidationError):
        LoginRequest(login="anna", password="")


def test_user_update_rejects_unknown_timezone() -> None:
    with pytest.raises(ValidationError):
        UserUpdate(timezone="Not/AZone")
