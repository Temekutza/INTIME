from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ItemTypeCode = Literal["task", "meeting", "reminder"]


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        raise ValueError("Укажите часовой пояс")
    return value


def _title(value: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError("Название не может быть пустым")
    return text


class ItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_type: ItemTypeCode
    status: str | None = None
    title: str
    description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    due_on: date | None = None
    due_at: datetime | None = None
    remind_at: datetime | None = None

    @field_validator("title")
    @classmethod
    def title_ok(cls, value: str) -> str:
        return _title(value)

    @field_validator("description")
    @classmethod
    def description_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None

    @field_validator("start_at", "end_at", "due_at", "remind_at")
    @classmethod
    def moments_ok(cls, value: datetime | None) -> datetime | None:
        return _aware(value)

    @field_validator("status")
    @classmethod
    def status_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip().lower()
        if not text:
            raise ValueError("Пустой статус")
        return text


class ItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_type: ItemTypeCode | None = None
    status: str | None = None
    title: str | None = None
    description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    due_on: date | None = None
    due_at: datetime | None = None
    remind_at: datetime | None = None

    @field_validator("title")
    @classmethod
    def title_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _title(value)

    @field_validator("description")
    @classmethod
    def description_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None

    @field_validator("start_at", "end_at", "due_at", "remind_at")
    @classmethod
    def moments_ok(cls, value: datetime | None) -> datetime | None:
        return _aware(value)

    @field_validator("status")
    @classmethod
    def status_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip().lower()
        if not text:
            raise ValueError("Пустой статус")
        return text


class ItemRead(BaseModel):
    id: int
    item_type: ItemTypeCode
    status: str
    title: str
    description: str | None
    start_at: datetime | None
    end_at: datetime | None
    due_on: date | None
    due_at: datetime | None
    remind_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ItemList(BaseModel):
    items: list[ItemRead]
    total: int


class ItemTypeRead(BaseModel):
    code: str
    name: str


class ItemStatusRead(BaseModel):
    code: str
    name: str


class ItemQuery(BaseModel):
    item_type: ItemTypeCode | None = None
    status: str | None = None
    q: str | None = Field(default=None, max_length=200)
    start: datetime | None = None
    end: datetime | None = None
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)
