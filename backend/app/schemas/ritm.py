import re
from datetime import date as Date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EventType = Literal["task", "meeting", "reminder"]
EventStatus = Literal["planned", "done"]
HEX = r"^#[0-9a-f]{6}$"
DATE = r"^\d{4}-\d{2}-\d{2}$"
TIME = r"^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$"


class RitmEvent(BaseModel):
    id: int
    type: EventType
    title: str
    date: str | None
    time: str | None
    duration_min: int | None
    is_deadline: bool
    status: EventStatus
    source: Literal["user", "archive"] = "user"
    source_ref: str | None = None
    created_at: str
    updated_at: str
    deleted_at: str | None = None
    workspace_id: int | None = None


class EventListResponse(BaseModel):
    events: list[RitmEvent]


class SearchHit(BaseModel):
    event: RitmEvent


class SearchResponse(BaseModel):
    hits: list[SearchHit]


class EventCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: EventType
    title: str
    date: str | None = None
    time: str | None = None
    duration_min: int | None = Field(default=None, ge=1, le=1440)
    is_deadline: bool = False
    color: str | None = None
    session_id: str | None = None
    request_id: str | None = None
    workspace_id: int | None = Field(default=None, ge=1)

    @field_validator("title")
    @classmethod
    def title_ok(cls, value: str) -> str:
        text = value.strip()
        if not text or len(text) > 300:
            raise ValueError("Название должно содержать от 1 до 300 символов")
        return text

    @field_validator("color")
    @classmethod
    def color_ok(cls, value: str | None) -> str | None:
        return _hex(value)

    @field_validator("session_id", "request_id")
    @classmethod
    def id_ok(cls, value: str | None) -> str | None:
        return _optional_id(value)

    @field_validator("date")
    @classmethod
    def date_ok(cls, value: str | None) -> str | None:
        return _optional_day(value)

    @field_validator("time")
    @classmethod
    def time_ok(cls, value: str | None) -> str | None:
        return _optional_clock(value)

    @model_validator(mode="after")
    def required_fields(self) -> "EventCreateRequest":
        if self.time and not self.date:
            raise ValueError("Для времени укажите дату")
        if self.type in {"meeting", "reminder"} and (not self.date or not self.time):
            raise ValueError("Для встречи или напоминания нужны дата и время")
        return self


class EventPatchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str | None = None
    date: str | None = None
    time: str | None = None
    status: EventStatus | None = None

    @field_validator("title")
    @classmethod
    def title_ok(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if not text or len(text) > 300:
            raise ValueError("Название должно содержать от 1 до 300 символов")
        return text

    @field_validator("date")
    @classmethod
    def date_ok(cls, value: str | None) -> str | None:
        return _optional_day(value)

    @field_validator("time")
    @classmethod
    def time_ok(cls, value: str | None) -> str | None:
        return _optional_clock(value)

    @model_validator(mode="after")
    def time_needs_date(self) -> "EventPatchRequest":
        if self.time and not self.date and "time" in self.model_fields_set and "date" in self.model_fields_set:
            raise ValueError("Для времени укажите дату")
        return self


class ColorBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    color: str | None = None

    @field_validator("color")
    @classmethod
    def color_ok(cls, value: str | None) -> str | None:
        return _hex(value)


class ColorSnapshot(BaseModel):
    defaults: dict[str, str | None]
    overrides: dict[str, str]


class ColorDefaultResponse(BaseModel):
    type: EventType
    color: str | None


class ColorOverrideResponse(BaseModel):
    event_id: int
    color: str | None


class MessageRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=4000)
    session_id: str | None = None
    request_id: str | None = None
    new_event_color: str | None = None
    require_confirmation: bool = False
    workspace_id: int | None = Field(default=None, ge=1)

    @field_validator("text")
    @classmethod
    def text_ok(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Пустой запрос")
        return text

    @field_validator("new_event_color")
    @classmethod
    def color_ok(cls, value: str | None) -> str | None:
        return _hex(value)

    @field_validator("session_id", "request_id")
    @classmethod
    def id_ok(cls, value: str | None) -> str | None:
        return _optional_id(value)


class ReplyResponse(BaseModel):
    kind: str
    text: str
    events: list[RitmEvent] = Field(default_factory=list)
    request_id: str | None = None
    proposal: dict[str, Any] | None = None
    suggestions: list[str] = Field(default_factory=list)
    expecting: str | None = None


class HistoryResponse(BaseModel):
    messages: list[dict[str, Any]]


class TranscriptionOut(BaseModel):
    text: str


def _optional_id(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _optional_day(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if re.fullmatch(DATE, text) is None:
        raise ValueError("Проверьте дату")
    try:
        parsed = Date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("Проверьте дату") from exc
    if parsed.isoformat() != text:
        raise ValueError("Проверьте дату")
    return text


def _optional_clock(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if re.fullmatch(TIME, text) is None:
        raise ValueError("Проверьте время")
    return text[:5]


def _hex(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip().lower()
    if not text:
        return None
    if len(text) == 4 and text[0] == "#" and all(ch in "0123456789abcdef" for ch in text[1:]):
        text = "#" + "".join(ch + ch for ch in text[1:])
    if re.fullmatch(HEX, text) is None:
        raise ValueError("Цвет должен быть в формате #rrggbb")
    return text
