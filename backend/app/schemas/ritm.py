import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EventType = Literal["task", "meeting", "reminder"]
EventStatus = Literal["planned", "done"]
HEX = r"^#[0-9a-f]{6}$"


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
