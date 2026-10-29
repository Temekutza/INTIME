from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _clean_login(value: str) -> str:
    text = value.strip()
    if text != value or not text or any(char.isspace() for char in text) or len(text) > 64:
        raise ValueError("Логин должен быть без пробелов, от 1 до 64 символов")
    return text


def _clean_email(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if any(char.isspace() for char in text) or text.count("@") != 1 or text.startswith("@"):
        raise ValueError("Некорректная почта")
    return text


def _clean_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Неизвестный часовой пояс") from exc
    return value


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str
    password: str = Field(min_length=8, max_length=128)
    email: str | None = None
    timezone: str = "UTC"

    @field_validator("login")
    @classmethod
    def login_ok(cls, value: str) -> str:
        return _clean_login(value)

    @field_validator("email")
    @classmethod
    def email_ok(cls, value: str | None) -> str | None:
        return _clean_email(value)

    @field_validator("timezone")
    @classmethod
    def timezone_ok(cls, value: str) -> str:
        return _clean_timezone(value)


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str
    password: str = Field(min_length=1, max_length=128)


class UserRead(BaseModel):
    id: int
    login: str
    email: str | None
    timezone: str
    created_at: datetime


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str | None = None
    email: str | None = None
    timezone: str | None = None

    @field_validator("login")
    @classmethod
    def login_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _clean_login(value)

    @field_validator("email")
    @classmethod
    def email_ok(cls, value: str | None) -> str | None:
        return _clean_email(value)

    @field_validator("timezone")
    @classmethod
    def timezone_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _clean_timezone(value)


class AuthResponse(BaseModel):
    user: UserRead
    token: str
